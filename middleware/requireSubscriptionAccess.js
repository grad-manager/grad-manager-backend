import { isTrialActive } from "../utils/trial.js";

const normalizePlan = (plan) => {
  const value = String(plan || "free").trim().toLowerCase();
  if (value === "premium" || value === "pro") {
    return "pro";
  }
  return "free";
};

const hasUnlockedAccess = (userData) => {
  if (!userData) {
    return false;
  }

  if (isTrialActive(userData.trial)) {
    return true;
  }

  return normalizePlan(userData.subscription?.plan) !== "free";
};

const requireSubscriptionAccess = (req, res, next) => {
  if (hasUnlockedAccess(req.user)) {
    return next();
  }

  return res.status(403).json({
    code: "SUBSCRIPTION_REQUIRED",
    message:
      "Your 3-day free trial has ended. Subscribe to Pro to continue.",
    subscriptionRequired: true,
    redirectTo: "/subscribe",
  });
};

export default requireSubscriptionAccess;
