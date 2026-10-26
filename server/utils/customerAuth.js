const supabase = require("../config/supabaseClient");
const { sendSetPasswordEmail } = require("./orderEmail");

/**
 * Ensures one customer account exists per email address (One person, one account).
 * If user signed in with Google, links to their Google account.
 * If user bought manually and has no account, creates a Supabase Auth account and sends set-password email.
 */
async function ensureCustomerAccount({ email, name, editionType }) {
  if (!email) return null;
  const cleanEmail = email.trim().toLowerCase();
  const clientUrl = process.env.CLIENT_URL || "https://siddiqui.digital";

  try {
    const { data: listData, error: listErr } = await supabase.auth.admin.listUsers();
    if (listErr) {
      console.warn("[ensureCustomerAccount] listUsers error:", listErr.message);
    }

    const existingUser = listData?.users?.find((u) => u.email?.toLowerCase() === cleanEmail);

    if (existingUser) {
      console.log("[ensureCustomerAccount] Existing account found for " + cleanEmail + " (ID: " + existingUser.id + ")");
      return existingUser;
    }

    console.log("[ensureCustomerAccount] Creating new reader account for manual buyer " + cleanEmail + "...");
    const { data: createData, error: createErr } = await supabase.auth.admin.createUser({
      email: cleanEmail,
      email_confirm: true,
      user_metadata: { full_name: name || "Valued Reader" },
    });

    if (createErr || !createData?.user) {
      console.warn("[ensureCustomerAccount] Could not create user:", createErr?.message);
      return null;
    }

    const newUser = createData.user;

    try {
      const { data: linkData, error: linkErr } = await supabase.auth.admin.generateLink({
        type: "recovery",
        email: cleanEmail,
        options: { redirectTo: clientUrl + "/reset-password" },
      });

      if (!linkErr && linkData?.properties?.action_link) {
        sendSetPasswordEmail({
          to: cleanEmail,
          customerName: name,
          setPasswordLink: linkData.properties.action_link,
          editionType,
        }).catch(e => console.warn("[ensureCustomerAccount] Set password email notice:", e.message));
      }
    } catch (e) {
      console.warn("[ensureCustomerAccount] Failed to send set-password link:", e.message);
    }

    return newUser;
  } catch (err) {
    console.error("[ensureCustomerAccount] Unexpected error:", err);
    return null;
  }
}

module.exports = {
  ensureCustomerAccount,
};
