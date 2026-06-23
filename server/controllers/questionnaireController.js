const supabase = require("../config/supabaseClient");

// ─── Category helper (mirrors frontend logic) ────────────────────────────────
const CATEGORY_RANGES = [
    { name: "Promotional Thinker", min: 0,  max: 2 },
    { name: "Sales Thinker",       min: 3,  max: 5 },
    { name: "Value Thinker",       min: 6,  max: 7 },
    { name: "Strategic Value Architect", min: 8, max: 9 },
];

function computeCategory(totalScore) {
    const cat = CATEGORY_RANGES.find((c) => totalScore >= c.min && totalScore <= c.max);
    return cat ? cat.name : "Promotional Thinker";
}

// Get all questions with their options
exports.getQuestions = async (req, res) => {
    try {
        const { data: questions, error } = await supabase
            .from("questions")
            .select(`
        id,
        question_text,
        created_at,
        question_options (
          id,
          option_text,
          votes
        )
      `)
            .order("created_at", { ascending: true });

        if (error) return res.status(400).json({ error: error.message });

        res.json({ questions });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

// Submit a vote for a question option (legacy per-question vote)
exports.submitVote = async (req, res) => {
    const { questionId, optionId } = req.body;

    if (!questionId || !optionId) {
        return res
            .status(400)
            .json({ error: "questionId and optionId are required" });
    }

    try {
        // Get current vote count for the option
        const { data: option, error: fetchError } = await supabase
            .from("question_options")
            .select("votes")
            .eq("id", optionId)
            .single();

        if (fetchError || !option) {
            return res.status(404).json({ error: "Option not found" });
        }

        // Increment vote count
        const { error: updateError } = await supabase
            .from("question_options")
            .update({ votes: option.votes + 1 })
            .eq("id", optionId);

        if (updateError) {
            return res.status(500).json({ error: updateError.message });
        }

        // Record the individual vote
        const voterIp =
            req.headers["x-forwarded-for"] || req.connection?.remoteAddress || "unknown";

        await supabase.from("question_votes").insert([
            {
                question_id: questionId,
                option_id: optionId,
                voter_ip: voterIp,
            },
        ]);

        // Return updated results with percentages
        const { data: allOptions, error: resultsError } = await supabase
            .from("question_options")
            .select("id, option_text, votes")
            .eq("question_id", questionId);

        if (resultsError) {
            return res.status(500).json({ error: resultsError.message });
        }

        const totalVotes = allOptions.reduce((sum, opt) => sum + opt.votes, 0);
        const results = allOptions.map((opt) => ({
            id: opt.id,
            option_text: opt.option_text,
            votes: opt.votes,
            percentage: totalVotes > 0 ? Math.round((opt.votes / totalVotes) * 100) : 0,
        }));

        res.json({
            message: "Vote recorded!",
            totalVotes,
            results,
        });
    } catch (error) {
        console.error("Vote error:", error);
        res.status(500).json({ error: error.message });
    }
};

// Submit a full questionnaire response (all questions at once)
exports.submitFullResponse = async (req, res) => {
    const { profile, answers, session_id } = req.body;

    if (!profile) {
        return res.status(400).json({ error: "profile is required" });
    }

    if (!answers || typeof answers !== "object" || Object.keys(answers).length === 0) {
        return res.status(400).json({ error: "answers object is required and must not be empty" });
    }

    const voterIp =
        req.headers["x-forwarded-for"] || req.connection?.remoteAddress || "unknown";

    try {
        // Compute total score + perception category from stored answer scores
        const totalScore = Object.values(answers).reduce((sum, a) => sum + (a.score || 0), 0);
        const perceptionCategory = computeCategory(totalScore);

        // Try inserting with all columns (including total_score and perception_category)
        // If the DB schema is missing those columns (error 42703), fall back to base columns only
        let submission, submissionError;

        const fullInsert = await supabase
            .from("questionnaire_submissions")
            .insert([
                {
                    profile,
                    answers,
                    total_score: totalScore,
                    perception_category: perceptionCategory,
                    voter_ip: voterIp,
                    session_id: session_id || null,
                },
            ])
            .select("id")
            .single();

        if (fullInsert.error && fullInsert.error.code === "42703") {
            // Column doesn't exist yet — insert without the new columns so data is still saved
            console.warn(
                "perception_category/total_score columns missing — inserting without them. " +
                "Run ALTER TABLE to add these columns: " +
                "ALTER TABLE questionnaire_submissions ADD COLUMN IF NOT EXISTS total_score INTEGER NOT NULL DEFAULT 0; " +
                "ALTER TABLE questionnaire_submissions ADD COLUMN IF NOT EXISTS perception_category TEXT;"
            );
            const fallbackInsert = await supabase
                .from("questionnaire_submissions")
                .insert([
                    {
                        profile,
                        answers,
                        voter_ip: voterIp,
                        session_id: session_id || null,
                    },
                ])
                .select("id")
                .single();
            submission = fallbackInsert.data;
            submissionError = fallbackInsert.error;
        } else {
            submission = fullInsert.data;
            submissionError = fullInsert.error;
        }

        if (submissionError) {
            console.error("Submission insert error:", submissionError);
            return res.status(500).json({ error: submissionError.message });
        }

        // Increment vote counts for each selected option
        const optionIds = Object.values(answers)
            .map((a) => a.option_id)
            .filter(Boolean);

        for (const optionId of optionIds) {
            // Fetch current votes
            const { data: opt } = await supabase
                .from("question_options")
                .select("votes")
                .eq("id", optionId)
                .single();

            if (opt) {
                await supabase
                    .from("question_options")
                    .update({ votes: (opt.votes || 0) + 1 })
                    .eq("id", optionId);
            }
        }

        res.json({
            message: "Response submitted successfully!",
            submission_id: submission.id,
        });
    } catch (error) {
        console.error("Full response submission error:", error);
        res.status(500).json({ error: error.message });
    }
};

// Get analytics — total submissions, category breakdown, per-question results
exports.getAnalytics = async (req, res) => {
    try {
        // Total submissions
        const { count: totalSubmissions, error: countError } = await supabase
            .from("questionnaire_submissions")
            .select("*", { count: "exact", head: true });

        if (countError) return res.status(500).json({ error: countError.message });

        // Category / profile breakdown
        const { data: profileData, error: profileError } = await supabase
            .from("questionnaire_submissions")
            .select("profile");

        if (profileError) return res.status(500).json({ error: profileError.message });

        const profileCounts = {};
        for (const row of profileData || []) {
            const key = row.profile || "Unknown";
            profileCounts[key] = (profileCounts[key] || 0) + 1;
        }

        const profileBreakdown = Object.entries(profileCounts).map(([profile, count]) => ({
            profile,
            count,
            percentage:
                totalSubmissions > 0 ? Math.round((count / totalSubmissions) * 100) : 0,
        }));

        // Per-question results with dynamic percentages
        const { data: questions, error: qError } = await supabase
            .from("questions")
            .select(`
        id,
        question_text,
        question_options (
          id,
          option_text,
          votes
        )
      `)
            .order("created_at", { ascending: true });

        if (qError) return res.status(500).json({ error: qError.message });

        const questionResults = (questions || []).map((q) => {
            const options = q.question_options || [];
            const totalVotes = options.reduce((sum, opt) => sum + (opt.votes || 0), 0);
            return {
                id: q.id,
                question_text: q.question_text,
                total_votes: totalVotes,
                options: options.map((opt) => ({
                    id: opt.id,
                    option_text: opt.option_text,
                    votes: opt.votes || 0,
                    percentage:
                        totalVotes > 0 ? Math.round(((opt.votes || 0) / totalVotes) * 100) : 0,
                })),
            };
        });

        res.json({
            total_submissions: totalSubmissions || 0,
            profile_breakdown: profileBreakdown,
            questions: questionResults,
        });
    } catch (error) {
        console.error("Analytics error:", error);
        res.status(500).json({ error: error.message });
    }
};

// Get results with percentages for a specific question
exports.getResults = async (req, res) => {
    const { questionId } = req.params;

    try {
        const { data: question, error: qError } = await supabase
            .from("questions")
            .select("id, question_text")
            .eq("id", questionId)
            .single();

        if (qError || !question) {
            return res.status(404).json({ error: "Question not found" });
        }

        const { data: options, error: oError } = await supabase
            .from("question_options")
            .select("id, option_text, votes")
            .eq("question_id", questionId);

        if (oError) return res.status(400).json({ error: oError.message });

        const totalVotes = options.reduce((sum, opt) => sum + opt.votes, 0);
        const results = options.map((opt) => ({
            id: opt.id,
            option_text: opt.option_text,
            votes: opt.votes,
            percentage: totalVotes > 0 ? Math.round((opt.votes / totalVotes) * 100) : 0,
        }));

        res.json({
            question: question.question_text,
            totalVotes,
            results,
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

// ─── Live Results — aggregated from JSONB answers ─────────────────────────
// Works without DB-seeded questions. Groups by question key + option text.
exports.getLiveResults = async (req, res) => {
    try {
        const { data, error } = await supabase
            .from("questionnaire_submissions")
            .select("answers, profile");

        if (error) return res.status(500).json({ error: error.message });

        const rows = data || [];
        const totalParticipants = rows.length;

        // Aggregate option text counts per question key
        // answers shape: { "q1": { option_text, question_text, score }, ... }
        const questionAgg = {}; // { q1: { "option text": count, ... }, q2: ..., q3: ... }
        const questionText = {}; // { q1: "What is...", ... }
        const profileAgg = {};

        for (const row of rows) {
            const answers = row.answers || {};

            // Profile aggregation
            const prof = row.profile || "Unknown";
            profileAgg[prof] = (profileAgg[prof] || 0) + 1;

            for (const [qKey, ans] of Object.entries(answers)) {
                if (!questionAgg[qKey]) questionAgg[qKey] = {};
                if (!questionText[qKey] && ans.question_text) questionText[qKey] = ans.question_text;

                const optText = ans.option_text || String(ans);
                questionAgg[qKey][optText] = (questionAgg[qKey][optText] || 0) + 1;
            }
        }

        // Build structured response per question key
        const questionResults = Object.entries(questionAgg).map(([qKey, optCounts]) => {
            const totalVotes = Object.values(optCounts).reduce((s, c) => s + c, 0);
            return {
                key: qKey,
                question_text: questionText[qKey] || qKey,
                total_votes: totalVotes,
                options: Object.entries(optCounts)
                    .sort((a, b) => b[1] - a[1])
                    .map(([optText, count]) => ({
                        option_text: optText,
                        votes: count,
                        percentage: totalVotes > 0 ? Math.round((count / totalVotes) * 100) : 0,
                    })),
            };
        });

        // Sort by question key (q1, q2, q3)
        questionResults.sort((a, b) => a.key.localeCompare(b.key));

        const profileBreakdown = Object.entries(profileAgg)
            .sort((a, b) => b[1] - a[1])
            .map(([profile, count]) => ({
                profile,
                count,
                percentage: totalParticipants > 0 ? Math.round((count / totalParticipants) * 100) : 0,
            }));

        return res.json({
            total_participants: totalParticipants,
            profile_breakdown: profileBreakdown,
            questions: questionResults,
        });
    } catch (error) {
        console.error("getLiveResults error:", error);
        res.status(500).json({ error: error.message });
    }
};