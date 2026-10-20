const supabase = require("../config/supabaseClient");

// Post a comment (requires userId or public guest submission)
exports.postComment = async (req, res) => {
    const { blogId, content, parentId, userId, userName } = req.body;

    if (!blogId || !content || !userName) {
        return res.status(400).json({
            error: "blogId, content, and userName are required",
        });
    }

    // Sanitize input to prevent stored XSS
    const sanitizedName = String(userName).trim().slice(0, 100).replace(/<[^>]+>/g, '');
    const sanitizedContent = String(content).trim().slice(0, 2000).replace(/<[^>]+>/g, '');

    if (!sanitizedName || !sanitizedContent) {
        return res.status(400).json({ error: "Valid name and comment text are required" });
    }

    try {
        let payload = {
            blog_id: blogId,
            parent_id: parentId || null,
            user_id: userId || null,
            user_name: sanitizedName,
            content: sanitizedContent,
            is_admin: false,
            is_approved: false,
            status: "pending",
        };

        let { data, error } = await supabase
            .from("blog_comments")
            .insert([payload])
            .select()
            .single();

        // Fallback: if is_approved column doesn't exist yet in Supabase
        if (error && (error.code === '42703' || error.message?.includes('is_approved'))) {
            delete payload.is_approved;
            delete payload.status;
            const retry = await supabase
                .from("blog_comments")
                .insert([payload])
                .select()
                .single();
            data = retry.data;
            error = retry.error;
        }

        if (error) return res.status(500).json({ error: error.message });

        res.json({
            message: "Your comment has been submitted for review. It will appear once approved.",
            comment: data
        });
    } catch (err) {
        console.error("Post comment error:", err);
        res.status(500).json({ error: "Failed to post comment" });
    }
};

// Get approved comments for a blog post
exports.getComments = async (req, res) => {
    const { blogId } = req.params;

    if (!blogId) {
        return res.status(400).json({ error: "blogId is required" });
    }

    try {
        const { data, error } = await supabase
            .from("blog_comments")
            .select("*")
            .eq("blog_id", blogId)
            .order("created_at", { ascending: true });

        if (error) return res.status(500).json({ error: error.message });

        // Filter: only show comments that are explicitly approved, or admin comments,
        // or existing comments where moderation fields are not yet set
        const approvedComments = (data || []).filter(c => {
            if (c.is_admin) return true;
            if (c.status === 'rejected') return false;
            if (c.is_approved === false && c.status === 'pending') return false;
            return true;
        });

        res.json({ comments: approvedComments });
    } catch (err) {
        console.error("Get comments error:", err);
        res.status(500).json({ error: "Failed to fetch comments" });
    }
};
