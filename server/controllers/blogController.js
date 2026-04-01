const supabase = require("../config/supabaseClient");

// Post a comment (requires userId from authenticated user)
exports.postComment = async (req, res) => {
    const { blogId, content, parentId, userId, userName } = req.body;

    if (!blogId || !content || !userId || !userName) {
        return res.status(400).json({
            error: "blogId, content, userId, and userName are required",
        });
    }

    try {
        const { data, error } = await supabase
            .from("blog_comments")
            .insert([
                {
                    blog_id: blogId,
                    parent_id: parentId || null,
                    user_id: userId,
                    user_name: userName,
                    content: content,
                    is_admin: false,
                },
            ])
            .select()
            .single();

        if (error) return res.status(500).json({ error: error.message });

        res.json({ message: "Comment posted", comment: data });
    } catch (err) {
        console.error("Post comment error:", err);
        res.status(500).json({ error: "Failed to post comment" });
    }
};

// Get all comments for a blog post
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

        res.json({ comments: data || [] });
    } catch (err) {
        console.error("Get comments error:", err);
        res.status(500).json({ error: "Failed to fetch comments" });
    }
};
