/**
 * marketingReclassified.js — Grounded Knowledge Engine for Marketing Reclassified
 * 
 * "Marketing Reclassified: A Principle-First Approach" by M. Q. Siddiqui
 * 
 * IMPORTANT ARCHITECTURAL RULE:
 * Ask SID is the digital book companion, NOT a generic support bot.
 * Answers must be strictly grounded in the approved principles and structure of the book.
 * Future AVF, VDI, and other publications can plug into this architecture seamlessly.
 */

const BOOK_METADATA = {
  title: "Marketing Reclassified: A Principle-First Approach",
  author: "M. Q. Siddiqui",
  slug: "marketing-reclassified-principle-first-approach",
  publicationUrl: "/publications/marketing-reclassified",
  summary: "A definitive strategic playbook challenging transactional and promotional myopia; establishing marketing as a principle-first leadership discipline centered on authentic value creation, customer relevance, strategic alignment, and sustainable growth."
};

/**
 * Approved principle knowledge nodes from Marketing Reclassified.
 * Each node provides structured insights, diagnostic questions, directions, and chapter references.
 */
const PRINCIPLE_LIBRARY = [
  {
    id: "purpose-to-profit",
    keywords: ["purpose", "profit", "foundation", "starting point", "core", "philosophy", "why we exist", "dna"],
    concepts: ["The DNA of Business", "Purpose to Profit Continuum", "Organic Profitability"],
    bookReference: {
      book: BOOK_METADATA.title,
      chapter: "Chapter 1: The Principle-First Mandate",
      section: "From Purpose to Profit: The DNA of Business",
      page: "Page 24",
      readUrl: BOOK_METADATA.publicationUrl
    },
    understanding: "You are questioning how foundational purpose translates into commercial viability and financial performance without compromising organizational integrity.",
    perspective: "In Marketing Reclassified, profit is explicitly defined as an outcome, never the operational starting point. When organizations begin with short-term revenue targets and work backwards, they inevitably compress value creation, dilute customer trust, and create value drift. True strategic marketing begins with defining the meaningful contribution of the enterprise, turning that purpose into authentic value, and allowing profitability to emerge as the organic dividend of consistent execution.",
    questionsToConsider: [
      "Is your current operational strategy driven by quarterly targets, or by the unique value your organization is uniquely qualified to create?",
      "If you stripped away all promotional messaging, what authentic human or business problem does your offering uniquely resolve?",
      "Where in your customer journey is short-term revenue pursuit creating friction with your long-term reputation?"
    ],
    possibleDirection: "Map your commercial activities across the Purpose-to-Profit Continuum: Purpose → Value Creation → Customer Relevance → Strategic Alignment → Sustainable Growth → Organic Profit. Identify where the chain breaks before adjusting tactical marketing spend.",
    requiresAdvisory: false
  },
  {
    id: "leads-not-converting",
    keywords: ["convert", "converting", "conversion", "leads", "funnel", "traffic", "acquisition", "pipeline"],
    concepts: ["The Acquisition Trap", "Relevance vs Promotion", "The Expectation Gap"],
    bookReference: {
      book: BOOK_METADATA.title,
      chapter: "Chapter 3: The Illusions of Modern Marketing",
      section: "Beyond the Lead Generation Treadmill",
      page: "Page 58",
      readUrl: BOOK_METADATA.publicationUrl
    },
    understanding: "Your top-of-funnel activity is attracting interest, but prospects stall or abandon before committing to a commercial relationship.",
    perspective: "Marketing Reclassified diagnoses lead-conversion failure not as a closing problem, but as an upstream relevance and promise disconnect. High lead volume combined with low conversion typically indicates that marketing campaigns are buying curiosity rather than addressing authentic intent. When promotional promises run ahead of product delivery or customer readiness, the prospect experiences hesitation at the moment of truth.",
    questionsToConsider: [
      "Are your lead generation campaigns attracting customers with real intent, or merely collecting contact details through inflated promises?",
      "Does the prospect's experience immediately after becoming a lead mirror the sophistication and tone of the initial advertisement?",
      "What unaddressed risk or ambiguity is forcing qualified buyers to pause before converting?"
    ],
    possibleDirection: "Audit the message-to-reality continuum. Instead of increasing lead volume or aggressive follow-ups, tighten qualifying criteria at the point of entry so every lead is already aligned with your core value proposition.",
    requiresAdvisory: false
  },
  {
    id: "value-proposition-relevance",
    keywords: ["value proposition", "relevance", "relevant", "differentiation", "positioning", "market fit"],
    concepts: ["Customer Relevance", "Meaningful Differentiation", "Market Reality Check"],
    bookReference: {
      book: BOOK_METADATA.title,
      chapter: "Chapter 4: Creating Meaningful Value",
      section: "Customer Relevance and the Test of Significance",
      page: "Page 86",
      readUrl: BOOK_METADATA.publicationUrl
    },
    understanding: "You need a disciplined way to evaluate whether what you offer still commands urgency and priority in your customer's evolving reality.",
    perspective: "A value proposition does not remain relevant simply because it was once successful. In Marketing Reclassified, relevance is dynamic—it exists only at the intersection of what the customer genuinely values and what the organization uniquely delivers. When a company defines value from its internal perspective (features, technology, effort) rather than customer reality, relevance quietly decays.",
    questionsToConsider: [
      "Has your customer's operating context, budget pressure, or primary anxiety shifted while your messaging remained static?",
      "Can your customers clearly articulate why choosing you is the only logical decision for their specific situation?",
      "Are you competing on external attributes (price, speed, features) because your core value lacks distinct strategic clarity?"
    ],
    possibleDirection: "Conduct a Customer Reality Review. Assess your offering against three criteria: (1) Does it solve a recognized, urgent challenge? (2) Is the value quantifiable in the buyer's terms? (3) Is your delivery unmistakably distinct from market substitutes?",
    requiresAdvisory: false
  },
  {
    id: "price-competition",
    keywords: ["price", "pricing", "discount", "discounting", "competitor", "cheaper", "lower prices", "margin", "undercut"],
    concepts: ["The Commoditization Spiral", "Value Preservation", "Pricing with Conviction"],
    bookReference: {
      book: BOOK_METADATA.title,
      chapter: "Chapter 5: Sustainable Growth vs Short-Term Tactics",
      section: "The Fallacy of Price-Led Competition",
      page: "Page 112",
      readUrl: BOOK_METADATA.publicationUrl
    },
    understanding: "Competitors are applying downward price pressure, tempting you to reduce prices to protect transaction volume.",
    perspective: "Marketing Reclassified strongly warns against entering a commoditization spiral. Price is the exchange mechanism for perceived value. When an organization cuts price in response to competitor action, it implicitly confirms that its offering is indistinguishable from the cheaper alternative. Discounting erodes operating margins necessary to sustain quality, alienates value-conscious buyers, and attracts price-sensitive churn.",
    questionsToConsider: [
      "If a competitor can offer lower prices sustainably, what structural advantage do they possess that you should not attempt to replicate?",
      "What non-price dimensions (certainty, domain expertise, accountability, strategic fit) do your customers value above a marginal cost reduction?",
      "Would reducing your price by 20% actually double your customer loyalty, or merely halve your profitability?"
    ],
    possibleDirection: "Do not reduce headline pricing without restructuring the value exchange. Instead, introduce clear tiering, unbundle ancillary services, or double down on high-trust segments where failure risk makes cheap alternatives unacceptable.",
    requiresAdvisory: true
  },
  {
    id: "strategic-marketing",
    keywords: ["strategic", "strategy", "tactics", "tactical", "framework", "leadership", "long-term", "alignment"],
    concepts: ["Principle-First Marketing", "Strategic Alignment", "Marketing as Leadership"],
    bookReference: {
      book: BOOK_METADATA.title,
      chapter: "Chapter 2: Marketing as a Strategic Discipline",
      section: "Elevating Marketing from Promotion to Architecture",
      page: "Page 42",
      readUrl: BOOK_METADATA.publicationUrl
    },
    understanding: "Your marketing feels reactive, tactical, and disconnected from executive strategy and organizational purpose.",
    perspective: "When marketing is reduced to marketing communication, campaigns become fragmented and reactive. Marketing Reclassified defines marketing not as an execution department, but as the strategic architecture that connects the entire enterprise to market reality. To make marketing strategic, leadership must integrate product development, customer experience, pricing philosophy, and market positioning into a single coherent system.",
    questionsToConsider: [
      "Is your marketing team measured primarily on outputs (posts, emails, clicks) or strategic outcomes (pricing power, customer retention, market authority)?",
      "Do non-marketing leaders in your organization view marketing as an expense line or as the strategic custodian of market relevance?",
      "Are your marketing investments reinforcing a multi-year competitive advantage, or merely feeding monthly pipeline anxiety?"
    ],
    possibleDirection: "Shift from calendar-driven campaign planning to principle-first strategic pillars. Establish clear boundary conditions for what your brand will never do, and align operational capabilities directly behind your most defensible value proposition.",
    requiresAdvisory: false
  },
  {
    id: "growth-vs-loyalty",
    keywords: ["loyalty", "churn", "retention", "growing", "growth", "drift", "experience", "decay", "disconnect"],
    concepts: ["Value Drift", "Growth Dilution", "The Customer Retention Anchor"],
    bookReference: {
      book: BOOK_METADATA.title,
      chapter: "Chapter 6: Protecting Against Value Drift",
      section: "When Growth Erodes Customer Trust",
      page: "Page 138",
      readUrl: BOOK_METADATA.publicationUrl
    },
    understanding: "The business is expanding top-line revenue or new accounts, but existing customer satisfaction and repeat engagement are declining.",
    perspective: "This is a classic manifestation of Value Drift, a central concept in M. Q. Siddiqui's frameworks. As organizations scale rapidly, operational complexity increases while customer intimacy decreases. The specialized care and attention that won early customers is replaced by standardized, cost-optimized processes. The organization believes it is winning because revenue is rising, while in reality it is exhausting its brand equity through silent attrition.",
    questionsToConsider: [
      "Are newer customers experiencing the exact same depth of value and care that your earliest loyal advocates received?",
      "Is organizational compensation incentivizing new account acquisition at the expense of retention and account expansion?",
      "What friction points have been introduced into your customer onboarding or post-purchase journey in the name of operational scaling?"
    ],
    possibleDirection: "Conduct an immediate Value Drift Diagnostic. Re-anchor your internal metrics around Net Retention and Customer Health before spending additional capital on new customer acquisition.",
    requiresAdvisory: true
  }
];

/**
 * Match user query against principle library
 */
function findMatchingPrinciple(query) {
  const q = String(query || "").toLowerCase();
  
  let bestMatch = null;
  let highestScore = 0;

  for (const node of PRINCIPLE_LIBRARY) {
    let score = 0;
    for (const kw of node.keywords) {
      if (q.includes(kw)) {
        score += kw.length > 5 ? 3 : 2;
      }
    }
    for (const concept of node.concepts) {
      if (q.includes(concept.toLowerCase())) {
        score += 4;
      }
    }

    if (score > highestScore) {
      highestScore = score;
      bestMatch = node;
    }
  }

  return highestScore >= 2 ? bestMatch : null;
}

/**
 * Generate grounded Ask SID response
 */
function generateGroundedResponse(query, conversationHistory = []) {
  const match = findMatchingPrinciple(query);

  // Check if query is completely off-topic (e.g. coding, unrelated trivia)
  const isBusinessRelated = /market|business|customer|sales|price|growth|brand|strategy|value|product|lead|client|revenue|loyalty|purpose|company|service|team|enterprise|industry/i.test(query);

  if (!isBusinessRelated && !match) {
    return {
      understanding: "You have raised an inquiry that sits outside the scope of strategic marketing and business architecture.",
      perspective: "Ask SID is the dedicated digital companion to 'Marketing Reclassified: A Principle-First Approach' by M. Q. Siddiqui. The available principles of the book do not provide a basis for an authoritative answer to this query. Its purpose is to guide readers and leaders through strategic marketing, customer relevance, purposeful growth, and business dilemmas.",
      questionsToConsider: [
        "What core business or marketing challenge is currently facing your organization?",
        "Are you examining questions around lead conversion, value proposition relevance, pricing strategy, or sustainable growth?"
      ],
      possibleDirection: "Please share a challenge related to your business strategy, customer engagement, brand positioning, or market relevance. Ask SID will explore it through the approved frameworks of Marketing Reclassified.",
      relevantBookSection: {
        book: BOOK_METADATA.title,
        chapter: "Introduction",
        section: "A Principle-First Approach to Modern Marketing",
        page: "Page 12",
        readUrl: BOOK_METADATA.publicationUrl
      },
      showAdvisoryCta: false,
      grounded: true,
      offTopic: true
    };
  }

  if (match) {
    return {
      understanding: match.understanding,
      perspective: match.perspective,
      questionsToConsider: match.questionsToConsider,
      possibleDirection: match.possibleDirection,
      relevantBookSection: match.bookReference,
      showAdvisoryCta: match.requiresAdvisory,
      grounded: true,
      offTopic: false
    };
  }

  // General business question grounded in overarching Marketing Reclassified ethos
  return {
    understanding: "You are evaluating a strategic challenge regarding organizational alignment, market execution, or commercial sustainability.",
    perspective: "In Marketing Reclassified, M. Q. Siddiqui emphasizes that every marketing challenge is fundamentally a strategic alignment challenge. When business outcomes falter, the solution is rarely to introduce more aggressive promotional tactics. Instead, leaders must examine whether the underlying value proposition is truly differentiated, whether the organization is listening to authentic customer reality, and whether internal resources are synchronized behind purposeful delivery.",
    questionsToConsider: [
      "Where in this situation are operational assumptions conflicting with actual customer behavior?",
      "Are you attempting to solve a structural or value problem with tactical marketing communication?",
      "What single principle from your founding purpose must remain non-negotiable as you address this challenge?"
    ],
    possibleDirection: "Examine the problem through the lens of the Purpose-to-Profit framework. Ensure that your team has clearly defined the meaningful value of the initiative before deciding on promotional channels or budget allocation.",
    relevantBookSection: {
      book: BOOK_METADATA.title,
      chapter: "Chapter 2: Marketing as a Strategic Discipline",
      section: "The Core Principles of Strategic Clarity",
      page: "Page 36",
      readUrl: BOOK_METADATA.publicationUrl
    },
    showAdvisoryCta: false,
    grounded: true,
    offTopic: false
  };
}

module.exports = {
  BOOK_METADATA,
  PRINCIPLE_LIBRARY,
  generateGroundedResponse
};
