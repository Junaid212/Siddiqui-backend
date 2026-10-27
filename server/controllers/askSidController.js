/**
 * askSidController.js — Controller for Ask SID Phase 1 API
 * 
 * Enforces server-side authorization:
 * - Digital Companion Edition ($49.99) -> Full Access
 * - Online Edition ($20) -> Online Reader only, limited demo if enabled
 * - Public Visitor -> Limited demo if enabled, else unauthorized
 */
const supabase = require('../config/supabaseClient');
const { getAskSidSettings } = require('../utils/askSidSettingsStore');
const { generateGroundedResponse } = require('../knowledge/marketingReclassified');

// In-memory tracking for demo session questions & basic rate limiting
// Key: demoSessionId or IP -> count
const demoUsageStore = new Map();
const rateLimitStore = new Map();

// Helper: Extract and clean client IP
function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    return forwarded.split(',')[0].trim();
  }
  return req.socket?.remoteAddress || '127.0.0.1';
}

// Helper: Verify user from Authorization header
async function verifyAuthUser(req) {
  const authHeader = req.headers.authorization || '';
  if (!authHeader.startsWith('Bearer ')) {
    return null;
  }
  const token = authHeader.substring(7).trim();
  if (!token) return null;

  try {
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (!error && user) {
      return user;
    }
  } catch (e) {
    console.warn('[askSidController] Auth token verification error:', e.message);
  }
  return null;
}

// Helper: Determine user entitlements from database
async function resolveUserEntitlements(user, settings) {
  if (!user || !user.email) {
    return {
      authenticated: false,
      hasCompanionAccess: false,
      hasOnlineAccess: false,
      accessLevel: 'none'
    };
  }

  const userEmail = user.email.toLowerCase().trim();
  const userId = user.id;

  try {
    // Check paid orders in Supabase
    const { data: orders, error } = await supabase
      .from('orders')
      .select('*')
      .or(`email.ilike.${userEmail},user_id.eq.${userId}`)
      .in('status', ['paid', 'successful']);

    if (error || !orders || orders.length === 0) {
      return {
        authenticated: true,
        userEmail,
        hasCompanionAccess: false,
        hasOnlineAccess: false,
        accessLevel: 'none'
      };
    }

    const fullProductId = String(settings.fullAccessProductId || '04b84648-3609-4b31-9ded-2486bacf1e74').toLowerCase();
    const onlineProductId = String(settings.onlineEditionProductId || 'prod_online_reading_001').toLowerCase();

    let hasCompanionAccess = false;
    let hasOnlineAccess = false;

    for (const order of orders) {
      const prodId = String(order.product_id || '').toLowerCase();
      const bookName = String(order.book_name || '').toLowerCase();

      // Check if matches Full Companion Edition product
      if (
        prodId === fullProductId ||
        (bookName.includes('marketing reclassified') && (bookName.includes('companion') || !bookName.includes('online')))
      ) {
        hasCompanionAccess = true;
      }

      // Check if matches Online Edition product
      if (
        prodId === onlineProductId ||
        bookName.includes('online') ||
        order.access_type === 'online'
      ) {
        hasOnlineAccess = true;
      }
    }

    let accessLevel = 'none';
    if (hasCompanionAccess) {
      accessLevel = 'full';
    } else if (hasOnlineAccess) {
      accessLevel = 'online_only';
    }

    return {
      authenticated: true,
      userEmail,
      hasCompanionAccess,
      hasOnlineAccess,
      accessLevel
    };
  } catch (err) {
    console.error('[askSidController] Error checking entitlements:', err);
    return {
      authenticated: true,
      userEmail,
      hasCompanionAccess: false,
      hasOnlineAccess: false,
      accessLevel: 'none'
    };
  }
}

/**
 * GET /api/ask-sid/config — Public configuration
 */
exports.getPublicConfig = async (req, res) => {
  try {
    const settings = await getAskSidSettings();
    return res.json({
      askSidEnabled: settings.askSidEnabled !== false,
      publicDemoEnabled: settings.publicDemoEnabled !== false,
      demoQuestionLimit: Number(settings.demoQuestionLimit || 1),
      upgradeCtaText: settings.upgradeCtaText || "Unlock Full Ask SID with the Digital Companion Edition ($49.99)",
      upgradeUrl: settings.upgradeUrl || "/publications/marketing-reclassified",
      advisoryCtaEnabled: settings.advisoryCtaEnabled !== false,
      advisoryUrl: settings.advisoryUrl || "/consultation"
    });
  } catch (e) {
    console.error('[getPublicConfig] Error:', e);
    return res.status(500).json({ error: 'Failed to load configuration' });
  }
};

/**
 * GET /api/ask-sid/access — Check current user entitlement & demo status
 */
exports.checkUserAccess = async (req, res) => {
  try {
    const settings = await getAskSidSettings();
    const user = await verifyAuthUser(req);
    const entitlements = await resolveUserEntitlements(user, settings);

    const clientKey = req.query.demoSessionId || getClientIp(req);
    const usedDemoCount = demoUsageStore.get(clientKey) || 0;
    const demoLimit = Number(settings.demoQuestionLimit || 1);
    const demoAvailable = settings.publicDemoEnabled !== false && usedDemoCount < demoLimit;
    const demoQuestionsRemaining = Math.max(0, demoLimit - usedDemoCount);

    return res.json({
      ...entitlements,
      askSidEnabled: settings.askSidEnabled !== false,
      publicDemoEnabled: settings.publicDemoEnabled !== false,
      demoAvailable,
      demoQuestionsRemaining,
      demoQuestionLimit: demoLimit,
      upgradeCtaText: settings.upgradeCtaText,
      upgradeUrl: settings.upgradeUrl,
      advisoryCtaEnabled: settings.advisoryCtaEnabled,
      advisoryUrl: settings.advisoryUrl
    });
  } catch (e) {
    console.error('[checkUserAccess] Error:', e);
    return res.status(500).json({ error: 'Failed to check access entitlement' });
  }
};

/**
 * POST /api/ask-sid/chat — Ask SID Conversation API (Server-side Authorized)
 */
exports.askQuestion = async (req, res) => {
  const { message, conversationHistory = [], demoSessionId } = req.body;

  if (!message || !String(message).trim()) {
    return res.status(400).json({ error: 'Message is required' });
  }

  try {
    const settings = await getAskSidSettings();

    // 1. Verify master availability
    if (settings.askSidEnabled === false) {
      return res.status(503).json({
        error: 'service_unavailable',
        message: 'Ask SID is temporarily unavailable. Please try again later.'
      });
    }

    // 2. Resolve authentication & entitlements
    const user = await verifyAuthUser(req);
    const entitlements = await resolveUserEntitlements(user, settings);

    const clientIp = getClientIp(req);
    const clientKey = demoSessionId || clientIp;

    // 3. Abuse / Rate Protection (Max 30 requests per minute per IP)
    const rateWindow = Math.floor(Date.now() / 60000);
    const rateKey = `${clientIp}_${rateWindow}`;
    const currentRate = (rateLimitStore.get(rateKey) || 0) + 1;
    rateLimitStore.set(rateKey, currentRate);
    if (currentRate > 30) {
      return res.status(429).json({
        error: 'rate_limited',
        message: 'You are submitting questions too quickly. Please pause a moment before continuing.'
      });
    }

    // 4. Server-Side Access Control Validation
    let isFullAccess = entitlements.hasCompanionAccess;
    let isDemoQuestion = false;
    let demoQuestionsRemaining = 0;

    if (isFullAccess) {
      // Authorized! Proceed with full conversation
    } else {
      // Check if demo trial is permitted
      if (settings.publicDemoEnabled !== false) {
        const usedDemoCount = demoUsageStore.get(clientKey) || 0;
        const demoLimit = Number(settings.demoQuestionLimit || 1);

        if (usedDemoCount < demoLimit) {
          // Allow this demo question!
          isDemoQuestion = true;
          demoUsageStore.set(clientKey, usedDemoCount + 1);
          demoQuestionsRemaining = Math.max(0, demoLimit - (usedDemoCount + 1));
        } else {
          // Demo exhausted!
          return res.status(403).json({
            error: 'demo_limit_reached',
            message: "You've reached the current demo limit. Unlock Full Ask SID with the Digital Companion Edition.",
            upgradeUrl: settings.upgradeUrl || "/publications/marketing-reclassified",
            upgradeCtaText: settings.upgradeCtaText
          });
        }
      } else {
        // Demo is disabled and user lacks full access
        return res.status(403).json({
          error: 'unauthorized',
          message: 'Full Ask SID access requires the Digital Companion Edition.',
          upgradeUrl: settings.upgradeUrl || "/publications/marketing-reclassified",
          upgradeCtaText: settings.upgradeCtaText
        });
      }
    }

    // 5. Generate Grounded AI Response
    const response = generateGroundedResponse(String(message).trim(), conversationHistory);

    return res.json({
      success: true,
      answer: response,
      isDemo: isDemoQuestion,
      demoQuestionsRemaining,
      accessLevel: entitlements.accessLevel
    });
  } catch (err) {
    console.error('[askQuestion] Error processing Ask SID query:', err);
    return res.status(500).json({
      error: 'internal_error',
      message: 'Something went wrong while processing your question. Please try again.'
    });
  }
};

/**
 * POST /api/ask-sid/reset-demo — Reset demo session (for testing/development)
 */
exports.resetDemo = (req, res) => {
  const { demoSessionId } = req.body;
  const clientKey = demoSessionId || getClientIp(req);
  demoUsageStore.delete(clientKey);
  return res.json({ success: true, message: 'Demo count reset' });
};
