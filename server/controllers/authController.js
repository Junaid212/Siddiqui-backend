const supabase = require("../config/supabaseClient");

// Google Sign-In: verify token via Google's tokeninfo endpoint, then upsert user
exports.googleSignIn = async (req, res) => {
    const { idToken } = req.body;

    if (!idToken) {
        return res.status(400).json({ error: "Google ID token is required" });
    }

    try {
        // Verify the Google ID token
        const response = await fetch(
            `https://oauth2.googleapis.com/tokeninfo?id_token=${idToken}`
        );
        const payload = await response.json();

        if (payload.error_description) {
            return res.status(401).json({ error: "Invalid Google token" });
        }

        // Check if the token's audience matches our client ID
        if (payload.aud !== process.env.GOOGLE_CLIENT_ID) {
            return res.status(401).json({ error: "Token audience mismatch" });
        }

        const { sub: googleId, email, name, picture } = payload;

        // Upsert user in Supabase
        const { data: existingUser, error: fetchError } = await supabase
            .from("users")
            .select("*")
            .eq("google_id", googleId)
            .single();

        let user;

        if (existingUser) {
            // Update existing user
            const { data, error } = await supabase
                .from("users")
                .update({ email, name, avatar: picture })
                .eq("google_id", googleId)
                .select()
                .single();

            if (error) return res.status(500).json({ error: error.message });
            user = data;
        } else {
            // Insert new user
            const { data, error } = await supabase
                .from("users")
                .insert([{ google_id: googleId, email, name, avatar: picture }])
                .select()
                .single();

            if (error) return res.status(500).json({ error: error.message });
            user = data;
        }

        res.json({
            message: "Sign-in successful",
            user: {
                id: user.id,
                email: user.email,
                name: user.name,
                avatar: user.avatar,
            },
        });
    } catch (error) {
        console.error("Google sign-in error:", error);
        res.status(500).json({ error: "Authentication failed" });
    }
};
