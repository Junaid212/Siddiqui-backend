const supabase = require("../config/supabaseClient");

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

// Submit a vote for a question option
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