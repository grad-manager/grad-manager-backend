import crypto from "crypto";
import express from "express";
import admin from "firebase-admin";
import axios from "axios";
import "dotenv/config";
import verifyToken from "../middleware/auth.js";
import { notifyUser } from "../services/notificationService.js";
import {
  buildPricingPayload,
  getCheckoutPlanDetails,
  resolvePricingContext,
} from "../utils/pricing.js";

const router = express.Router();
const db = admin.firestore();

const PAYSTACK_API_BASE_URL = "https://api.paystack.co";

const normalizeSubscriptionPlan = (plan) => {
  const value = String(plan || "free").trim().toLowerCase();
  if (value === "premium") {
    return "pro";
  }
  if (value === "pro") {
    return "pro";
  }
  return "free";
};

const buildSubscriptionUpdate = ({
  plan,
  paymentCurrency,
  paymentAmount,
  paymentReference,
  paymentGateway,
  durationMonths = 3,
}) => {
  const expirationDate = new Date();
  expirationDate.setMonth(expirationDate.getMonth() + durationMonths);

  return {
    subscriptionUpdate: {
      subscription: {
        plan,
        status: "active",
        startDate: new Date().toISOString(),
        expirationDate: expirationDate.toISOString(),
        paymentReference,
        paymentCurrency,
        paymentAmount,
        paymentGateway,
      },
    },
    expirationDate,
  };
};

const notifyAdmins = async ({ senderId, userEmail, plan, userId }) => {
  try {
    const adminsSnapshot = await db
      .collection("users")
      .where("role", "==", "admin")
      .get();

    const adminNotifications = adminsSnapshot.docs.map((doc) =>
      notifyUser(doc.id, {
        senderId,
        pushTitle: "Subscription Update",
        pushBody: `${userEmail || "A user"} activated the ${plan} plan.`,
        emailSubject: "Subscription Update",
        emailHtml: `<p>${userEmail || "A user"} activated the ${plan} plan.</p>`,
        pushUrl: "/admin/subscriptions-payments",
        type: "GENERAL",
        relatedEntityId: userId || senderId,
        metadata: { plan },
      })
    );

    await Promise.allSettled(adminNotifications);
  } catch (error) {
    console.error("Failed to notify admins about subscription update:", error);
  }
};

const getPaystackSecretKey = () => process.env.PAYSTACK_SECRET_KEY || "";

const getPaystackHeaders = () => ({
  Authorization: `Bearer ${getPaystackSecretKey()}`,
  "Content-Type": "application/json",
});

const assertPaystackConfigured = () => {
  if (!getPaystackSecretKey()) {
    throw new Error(
      "Paystack secret key is not configured. Please set PAYSTACK_SECRET_KEY."
    );
  }
};

const initializePaystack = async (userEmail, userId, plan, planDetails, clientUrl) => {
  assertPaystackConfigured();

  const amountKobo = Math.round(planDetails.amount * 100);

  const response = await axios.post(
    `${PAYSTACK_API_BASE_URL}/transaction/initialize`,
    {
      email: userEmail,
      amount: amountKobo,
      currency: planDetails.currency,
      reference: `PSTK_${Date.now()}_${userId}`,
      callback_url: `${clientUrl.replace(/\/$/, "")}/subscribe`,
      metadata: {
        userId,
        plan,
        gateway: "paystack",
        paymentCurrency: planDetails.currency,
        paymentAmount: planDetails.amount,
        expectedAmountKobo: amountKobo,
      },
    },
    {
      headers: getPaystackHeaders(),
      timeout: 10000,
    }
  );

  if (!response.data?.status || !response.data?.data?.authorization_url) {
    throw new Error(
      response.data?.message || "Paystack initialization failed."
    );
  }

  return {
    authorizationUrl: response.data.data.authorization_url,
    reference: response.data.data.reference,
  };
};

const isPaymentAmountValid = (amountKobo, expectedAmountKobo) => {
  const numericAmount = Number(amountKobo);
  const numericExpected = Number(expectedAmountKobo);

  if (!Number.isFinite(numericAmount) || !Number.isFinite(numericExpected)) {
    return false;
  }

  return numericAmount >= numericExpected;
};

router.get("/context", async (req, res) => {
  try {
    const pricingContext = await resolvePricingContext(req);
    return res.status(200).json({
      success: true,
      ...(await buildPricingPayload(pricingContext)),
    });
  } catch (error) {
    console.error("Failed to build payment context:", error.message);
    return res.status(500).json({
      success: false,
      message: "Unable to resolve pricing for your location right now.",
    });
  }
});

router.get("/initialize", verifyToken, async (req, res) => {
  const userId = req.user.uid;
  const userEmail = req.user.email;
  const plan = normalizeSubscriptionPlan(req.query.plan);

  if (!["free", "pro"].includes(plan)) {
    return res
      .status(400)
      .json({ success: false, message: "Invalid or missing plan parameter." });
  }

  try {
    if (plan === "free") {
      const userDocRef = db.collection("users").doc(userId);
      const { subscriptionUpdate, expirationDate } = buildSubscriptionUpdate({
        plan: "free",
        paymentCurrency: "NGN",
        paymentAmount: 0,
        paymentReference: null,
        paymentGateway: null,
      });

      await userDocRef.update(subscriptionUpdate);

      await notifyAdmins({
        senderId: userId,
        userEmail,
        plan: "free",
        userId,
      });

      return res.status(200).json({
        success: true,
        message: "Free plan successfully activated.",
        isFreePlan: true,
        expirationDate: expirationDate.toISOString(),
      });
    }

    const planDetails = await getCheckoutPlanDetails(req, plan);
    if (!planDetails) {
      return res.status(500).json({
        success: false,
        message: "Unable to determine your NGN checkout amount.",
      });
    }

    const clientUrl = process.env.CLIENT_URL || "http://localhost:5173";
    const initializationResult = await initializePaystack(
      userEmail,
      userId,
      plan,
      planDetails,
      clientUrl
    );

    return res.status(200).json({
      success: true,
      message: "Payment initialized via Paystack.",
      authorizationUrl: initializationResult.authorizationUrl,
      reference: initializationResult.reference,
      isFreePlan: false,
      checkoutCurrency: planDetails.currency,
    });
  } catch (error) {
    console.error(
      `Error initializing payment for plan ${plan} via Paystack:`,
      error.message
    );
    if (error.response) {
      console.error("Paystack error:", error.response.data);
    }

    return res.status(500).json({
      success: false,
      message:
        error.response?.data?.message ||
        error.message ||
        "Server error during payment initialization.",
    });
  }
});

router.get("/verify", verifyToken, async (req, res) => {
  const { reference } = req.query;
  const userId = req.user.uid;

  if (!reference) {
    return res.status(400).json({
      success: false,
      message: "Missing payment reference.",
    });
  }

  try {
    assertPaystackConfigured();

    const verificationResponse = await axios.get(
      `${PAYSTACK_API_BASE_URL}/transaction/verify/${reference}`,
      {
        headers: getPaystackHeaders(),
        timeout: 10000,
      }
    );

    const data = verificationResponse.data?.data;

    if (!verificationResponse.data?.status || data?.status !== "success") {
      return res.status(400).json({
        success: false,
        message: "Payment verification failed or transaction not successful via Paystack.",
      });
    }

    const plan = normalizeSubscriptionPlan(data.metadata?.plan);
    const txUserId = data.metadata?.userId || null;
    const paymentCurrency = data.currency || "NGN";
    const paymentReference = data.reference;
    const paymentAmount = Number(data.amount || 0) / 100;
    const expectedAmountKobo = data.metadata?.expectedAmountKobo;

    if (!isPaymentAmountValid(data.amount, expectedAmountKobo)) {
      return res.status(400).json({
        success: false,
        message: "Security Error: Amount paid is less than expected.",
      });
    }

    if (txUserId !== userId) {
      return res.status(403).json({
        success: false,
        message: "Security error: Transaction user mismatch.",
      });
    }

    const userDocRef = db.collection("users").doc(userId);
    const { subscriptionUpdate, expirationDate } = buildSubscriptionUpdate({
      plan,
      paymentCurrency,
      paymentAmount,
      paymentReference,
      paymentGateway: "paystack",
    });

    await userDocRef.update(subscriptionUpdate);

    void notifyUser(userId, {
      pushTitle: "Subscription activated",
      pushBody: `Your ${plan} subscription is now active.`,
      emailSubject: `Subscription to ${plan} activated`,
      emailHtml: `<p>Your ${plan} subscription is active and will expire on ${expirationDate.toISOString()}.</p>`,
      type: "subscription_activated",
    }).catch((error) => {
      console.error("Failed to notify user about subscription activation:", error);
    });

    return res.status(200).json({
      success: true,
      message: `Subscription to ${plan} successfully activated via Paystack.`,
      expirationDate: expirationDate.toISOString(),
    });
  } catch (error) {
    console.error("Error verifying payment via Paystack:", error.message);
    if (error.response) {
      console.error("Paystack verification error:", error.response.data);
    }

    return res.status(500).json({
      success: false,
      message: "Server error during payment verification.",
    });
  }
});

export const handlePaystackWebhook = async (req, res) => {
  const secretKey = getPaystackSecretKey();
  if (!secretKey) {
    console.error("Paystack secret key not configured.");
    return res.status(500).json({ message: "Webhook not configured." });
  }

  const rawBody = req.rawBody || JSON.stringify(req.body || {});
  const expectedSignature = crypto
    .createHmac("sha512", secretKey)
    .update(rawBody)
    .digest("hex");
  const signature = req.headers["x-paystack-signature"];

  if (!signature || signature !== expectedSignature) {
    return res.status(401).json({ message: "Invalid webhook signature." });
  }

  try {
    const payload = req.body || {};
    if (payload.event !== "charge.success") {
      return res.status(200).json({ message: "Event ignored." });
    }

    const data = payload.data || {};
    const plan = normalizeSubscriptionPlan(data.metadata?.plan);
    const txUserId = data.metadata?.userId;
    const paymentCurrency = data.currency || "NGN";
    const paymentReference = data.reference;
    const paymentAmount = Number(data.amount || 0) / 100;
    const expectedAmountKobo = data.metadata?.expectedAmountKobo;

    if (!txUserId || !paymentReference || !paymentCurrency) {
      return res
        .status(400)
        .json({ message: "Missing required payment metadata." });
    }

    if (!isPaymentAmountValid(data.amount, expectedAmountKobo)) {
      return res
        .status(400)
        .json({ message: "Security Error: Amount paid is less than expected." });
    }

    const userDocRef = db.collection("users").doc(txUserId);
    const userDoc = await userDocRef.get();
    if (!userDoc.exists) {
      return res.status(404).json({ message: "User not found." });
    }

    const currentSubscription = userDoc.data()?.subscription || {};
    if (
      currentSubscription.paymentReference === paymentReference &&
      currentSubscription.status === "active"
    ) {
      return res.status(200).json({ message: "Payment already processed." });
    }

    const { subscriptionUpdate, expirationDate } = buildSubscriptionUpdate({
      plan,
      paymentCurrency,
      paymentAmount,
      paymentReference,
      paymentGateway: "paystack",
    });

    await userDocRef.update(subscriptionUpdate);

    try {
      await notifyUser(txUserId, {
        pushTitle: "Subscription activated",
        pushBody: `Your ${plan} subscription is now active.`,
        emailSubject: `Subscription to ${plan} activated`,
        emailHtml: `<p>Your ${plan} subscription is active and will expire on ${expirationDate.toISOString()}.</p>`,
        type: "subscription_activated",
      });
    } catch (error) {
      console.error(
        "Failed to notify user about subscription activation (webhook):",
        error
      );
    }

    await notifyAdmins({
      senderId: txUserId,
      userEmail: userDoc.data()?.email || null,
      plan,
      userId: txUserId,
    });

    return res.status(200).json({ message: "Webhook processed." });
  } catch (error) {
    console.error("Error processing Paystack webhook:", error);
    return res.status(500).json({ message: "Webhook processing failed." });
  }
};

router.post("/cancel-subscription", verifyToken, async (req, res) => {
  const userId = req.user.uid;
  const userDocRef = db.collection("users").doc(userId);

  try {
    const userDoc = await userDocRef.get();
    const currentSubscription = userDoc.data()?.subscription;

    if (!currentSubscription) {
      return res.status(404).json({
        success: false,
        message: "No active subscription found.",
      });
    }

    console.log(
      `TODO: Cancel recurring charges for ${currentSubscription.paymentGateway} reference ${currentSubscription.paymentReference}`
    );

    await userDocRef.update({
      "subscription.status": "cancelled",
      "subscription.cancellationDate": new Date().toISOString(),
    });

    return res.status(200).json({
      success: true,
      message:
        "Subscription successfully scheduled for cancellation at the next expiration date.",
      status: "cancelled",
      expirationDate: currentSubscription.expirationDate,
    });
  } catch (error) {
    console.error("Error cancelling subscription:", error.message);
    return res.status(500).json({
      success: false,
      message: "Server error during subscription cancellation.",
    });
  }
});

export default router;
