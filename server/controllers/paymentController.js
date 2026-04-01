const Stripe = require("stripe");
const supabase = require("../config/supabaseClient");
require("dotenv").config();

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Get all ebooks from the catalog
exports.getEbooks = async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("ebooks")
      .select("*")
      .order("created_at", { ascending: false });

    if (error) return res.status(400).json({ error: error.message });

    res.json({ ebooks: data });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// Create a Stripe Checkout session for ebook purchase
exports.createCheckoutSession = async (req, res) => {
  const { bookName, amount, userId, email } = req.body;

  if (!bookName || !amount) {
    return res.status(400).json({ error: "bookName and amount are required" });
  }

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      customer_email: email || undefined,
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: {
              name: bookName,
            },
            unit_amount: Math.round(amount * 100),
          },
          quantity: 1,
        },
      ],
      mode: "payment",
      metadata: {
        userId: userId || "guest",
        bookName,
      },
      success_url: `${process.env.CLIENT_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.CLIENT_URL}/cancel`,
    });

    // Record order in Supabase
    await supabase.from("orders").insert([
      {
        user_id: userId || null,
        email: email || null,
        stripe_session_id: session.id,
        book_name: bookName,
        amount,
        status: "pending",
      },
    ]);

    res.json({ url: session.url, sessionId: session.id });
  } catch (error) {
    console.error("Checkout error:", error);
    res.status(500).json({ error: error.message });
  }
};

// Get order status by Stripe session ID
exports.getOrderStatus = async (req, res) => {
  const { sessionId } = req.params;

  try {
    const { data, error } = await supabase
      .from("orders")
      .select("*")
      .eq("stripe_session_id", sessionId)
      .single();

    if (error) return res.status(404).json({ error: "Order not found" });

    res.json({ order: data });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// Stripe Webhook handler — marks order as paid
exports.stripeWebhook = async (req, res) => {
  const sig = req.headers["stripe-signature"];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error("Webhook signature verification failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;

    const { error } = await supabase
      .from("orders")
      .update({ status: "paid" })
      .eq("stripe_session_id", session.id);

    if (error) {
      console.error("Failed to update order status:", error);
    } else {
      console.log(`Order ${session.id} marked as paid`);
    }
  }

  res.json({ received: true });
};