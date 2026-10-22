const supabase = require("../config/supabaseClient");
const nodemailer = require("nodemailer");

async function findUserByEmail(email) {
  if (!email) return null;
  const cleanEmail = email.trim().toLowerCase();
  try {
    const { data, error } = await supabase.auth.admin.listUsers();
    if (error || !data?.users) return null;
    return data.users.find((u) => u.email?.toLowerCase() === cleanEmail) || null;
  } catch (err) {
    console.error("[findUserByEmail] Error:", err.message);
    return null;
  }
}

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

    if (payload.aud !== process.env.GOOGLE_CLIENT_ID) {
      return res.status(401).json({ error: "Token audience mismatch" });
    }

    const { sub: googleId, email, name, picture } = payload;

    // Upsert user in Supabase
    const { data: existingUser } = await supabase
      .from("users")
      .select("*")
      .eq("google_id", googleId)
      .single();

    let user;

    if (existingUser) {
      const { data, error } = await supabase
        .from("users")
        .update({ email, name, avatar: picture })
        .eq("google_id", googleId)
        .select()
        .single();

      if (error) return res.status(500).json({ error: error.message });
      user = data;
    } else {
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

// Check Account Type (Google vs Email user detection)
exports.checkAccountType = async (req, res) => {
  const email = (req.query.email || "").trim().toLowerCase();
  if (!email) return res.status(400).json({ error: "Email is required" });

  try {
    const user = await findUserByEmail(email);
    if (!user) {
      return res.json({ exists: false, isGoogle: false });
    }

    const providers = user.app_metadata?.providers || (user.app_metadata?.provider ? [user.app_metadata.provider] : []);
    const identities = user.identities || [];
    const hasGoogle = providers.includes("google") || identities.some((i) => i.provider === "google");
    const hasEmail = providers.includes("email") || identities.some((i) => i.provider === "email");

    if (hasGoogle && !hasEmail) {
      return res.json({
        exists: true,
        isGoogle: true,
        provider: "google",
        message: "This account uses Google sign-in.",
      });
    }

    return res.json({
      exists: true,
      isGoogle: false,
      provider: "email",
    });
  } catch (err) {
    console.error("[checkAccountType] Error:", err);
    return res.status(500).json({ error: "Failed to check account type" });
  }
};

// Forgot Password / Set Password Link Sender
exports.forgotPassword = async (req, res) => {
  const email = (req.body?.email || "").trim().toLowerCase();
  if (!email) return res.status(400).json({ error: "Email address is required" });

  try {
    const user = await findUserByEmail(email);
    if (!user) {
      return res.status(404).json({ error: "No account found with this email address. Please check for typos or sign in with Google." });
    }

    const providers = user.app_metadata?.providers || (user.app_metadata?.provider ? [user.app_metadata.provider] : []);
    const identities = user.identities || [];
    const hasGoogle = providers.includes("google") || identities.some((i) => i.provider === "google");
    const hasEmail = providers.includes("email") || identities.some((i) => i.provider === "email");

    // Provider-safe forgot password recovery:
    // If account uses Google-only, send a dedicated email advising them to sign in via Google.
    // Do not leak account existence or provider to unauthenticated callers.
    if (hasGoogle && !hasEmail) {
      try {
        const clientUrl = process.env.CLIENT_URL || "https://siddiqui.digital";
        const transporter = nodemailer.createTransport({
          host: process.env.SMTP_HOST || "smtp.ipage.com",
          port: Number(process.env.SMTP_PORT) || 465,
          secure: true,
          auth: {
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASS,
          },
        });

        await transporter.sendMail({
          from: process.env.SMTP_FROM || 'Siddiqui Digital <no-reply@siddiqui.digital>',
          to: email,
          subject: "Your Siddiqui.Digital Reader Account — Sign In Instructions",
          html: `
            <div style="font-family: sans-serif; max-width: 560px; margin: 0 auto; padding: 24px; color: #18181b;">
              <h2 style="color: #c80808;">Siddiqui.Digital Account Sign In</h2>
              <p>Hello,</p>
              <p>We received a request to reset the password for your reader account at <strong>${email}</strong>.</p>
              <p>Your account was created using <strong>Google Sign-In</strong>. You do not need a separate password to log in.</p>
              <div style="margin: 24px 0;">
                <a href="${clientUrl}/login" style="background: #18181b; color: #ffffff; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: 600; display: inline-block;">
                  Sign In with Google
                </a>
              </div>
              <p style="font-size: 13px; color: #71717a;">If you did not make this request, you can safely ignore this email.</p>
            </div>
          `,
        });
      } catch (mailErr) {
        console.warn("[forgotPassword] Google-user guidance email error:", mailErr.message);
      }

      return res.json({
        success: true,
        message: "If an account exists for this email, password recovery instructions have been sent to your inbox."
      });
    }

    const clientUrl = process.env.CLIENT_URL || "https://siddiqui.digital";
    const { data: linkData, error: linkErr } = await supabase.auth.admin.generateLink({
      type: "recovery",
      email,
      options: { redirectTo: `${clientUrl}/reset-password` },
    });

    if (linkErr) {
      console.error("[forgotPassword] generateLink error:", linkErr);
      return res.status(500).json({ error: "Failed to generate password recovery link." });
    }

    const actionLink = linkData?.properties?.action_link;

    const port = parseInt(process.env.SMTP_PORT, 10) || 465;
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: port,
      secure: port === 465,
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
      connectionTimeout: 15000,
      socketTimeout: 15000,
    });

    const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0f0f12;color:#e4e4e7;padding:32px 20px;">
      <div style="max-width:540px;margin:0 auto;background:#18181b;border:1px solid #27272a;border-radius:12px;padding:32px;">
        <h2 style="color:#ffffff;margin-top:0;">Set or Reset Your Password</h2>
        <p style="color:#a1a1aa;line-height:1.6;font-size:15px;">
          You requested to set or reset the password for your <strong>Siddiqui.Digital</strong> reader account.
        </p>
        <div style="margin:28px 0;text-align:center;">
          <a href="${actionLink}" style="background:#c80808;color:#ffffff;padding:14px 30px;border-radius:8px;font-weight:700;text-decoration:none;display:inline-block;font-size:15px;">
            Set / Reset Password
          </a>
        </div>
        <p style="color:#71717a;font-size:12px;line-height:1.5;">
          If you didn't make this request, you can safely ignore this email. Your account remains secure.<br/>
          This link will expire in 24 hours.
        </p>
      </div>
    </div>
    `;

    await transporter.sendMail({
      from: `"${process.env.EMAIL_FROM_NAME || 'M. Q. Siddiqui'}" <${process.env.EMAIL_FROM || process.env.SMTP_USER}>`,
      to: email,
      subject: "Set or reset your password — Siddiqui.Digital",
      html,
    });

    return res.json({
      success: true,
      message: "A password link has been sent to your email address.",
    });
  } catch (err) {
    console.error("[forgotPassword] Error:", err);
    return res.status(500).json({ error: err.message || "Failed to process request." });
  }
};
