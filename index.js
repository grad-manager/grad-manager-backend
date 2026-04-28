// Load environment variables
import "dotenv/config";
import express from "express";
import cors from "cors";
import mongoose from "mongoose";
import session from "express-session";
import passport from "./auth/googleAuth.js";
import MongoStore from "connect-mongo";
import multer from "multer";
import { CloudinaryStorage } from "multer-storage-cloudinary";
import { v2 as cloudinary } from "cloudinary";
import path from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";

// Services & Models
import startCronJob from "./services/cron-job.js";
import Document from "./models/Document.js";

// Firebase Admin
import { admin, db } from "./config/firebase-config.js";
import verifyToken from "./middleware/auth.js";
import requireSubscriptionAccess from "./middleware/requireSubscriptionAccess.js";

// === ROUTES ===
import applicationRoutes from "./routes/applicationRoutes.js";
import feedbackRoutes from "./routes/feedbackRoutes.js";
import programRoutes from "./routes/programRoutes.js";
import userRoutes from "./routes/users.js";
import authRoutes from "./routes/authRoutes.js";
import emailRoutes from "./routes/emailRoutes.js";
import adminRoutes from "./routes/admin.js";
import mentorsRouter from "./routes/mentorRoutes.js";
import menteeRoutes from "./routes/menteeRoutes.js";
import notificationRoutes from "./routes/notificationRoutes.js";
import sopRequestsRoutes from "./routes/sopRequestsRoutes.js";
import connectionsRoutes from "./routes/connections.js";
import groupsRoutes from "./routes/groups.js";
import agoraRoutes from "./routes/agoraRoutes.js";
import projectRoutes from "./routes/projectRoutes.js";
import interviewPrepRoutes from "./routes/interviewPrepRoutes.js";
import financialSupportRoutes from "./routes/financialSupportRoutes.js";
import chatRoutes from "./routes/chatRoutes.js";
import cvServiceRoutes from "./routes/cvServiceRoutes.js";
import welcomeEmailRoutes from "./routes/welcomeEmailRoutes.js";
import pushRoutes from "./routes/pushRoutes.js";
import communityRoutes from "./routes/communityRoutes.js";

// === NEW AI ROUTES ===
import aiRoutes from "./routes/aiRoutes.js";

// === NEW ADDITIONS ===
import visaInterviewPrepRoutes from "./routes/visaInterviewPrepRoutes.js";
import suggestionsRoutes from "./routes/suggestionsRoutes.js";
import paymentRoutes, { handlePaystackWebhook } from "./routes/payment.js";

// Import scraper controller (for manual triggers or debugging)
import { runAllScrapers } from "./scrapers/index.js";

// Initialize express
const app = express();

// === ES Module fix for __dirname ===
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// === DATABASE CONNECTION (MongoDB + Firestore Cron) ===
mongoose
  .connect(process.env.MONGO_URI)
  .then(() => {
    console.log("MongoDB connected successfully");
    startCronJob(); // starts weekly cron scraper
  })
  .catch((err) => console.error("MongoDB connection error:", err));

// === CORS CONFIGURATION ===
const allowedOrigins = [
  "https://grad-manager-pied.vercel.app",
  "https://grad-tracker-pied.vercel.app",
  "https://www.gradmanagers.com",
  "https://gradmanagers.com",
  process.env.CLIENT_URL,
];

const allowedOriginPatterns = [/^https:\/\/[a-z0-9-]+\.vercel\.app$/i];

const corsOptions = {
  origin: (origin, callback) => {
    const isAllowedPattern = allowedOriginPatterns.some((pattern) =>
      pattern.test(origin || ""),
    );

    if (!origin || allowedOrigins.includes(origin) || isAllowedPattern) {
      callback(null, true);
    } else {
      console.warn(`CORS block: Origin ${origin} not allowed.`);
      callback(new Error("Not allowed by CORS"), false);
    }
  },
  methods: "GET,HEAD,PUT,PATCH,POST,DELETE",
  credentials: true,
  optionsSuccessStatus: 204,
};

app.use(cors(corsOptions));
app.options(/.*/, cors(corsOptions));

// === COOP FIX (Google OAuth popups) ===
app.use((req, res, next) => {
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin-allow-popups");
  next();
});

// === MIDDLEWARE ===
app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf.toString();
    },
  }),
);

// === SESSION CONFIG ===
app.use(
  session({
    secret: process.env.SESSION_SECRET || "a-very-secure-secret",
    resave: false,
    saveUninitialized: false,
    store: MongoStore.create({
      mongoUrl: process.env.MONGO_URI,
      collectionName: "sessions",
      ttl: 14 * 24 * 60 * 60,
      autoRemove: "native",
    }),
    cookie: {
      maxAge: 14 * 24 * 60 * 60 * 1000,
      secure: process.env.NODE_ENV === "production",
      httpOnly: true,
      sameSite: "lax",
    },
  }),
);

app.use(passport.initialize());
app.use(passport.session());

// === CLOUDINARY CONFIG ===
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// === MULTER CLOUDINARY STORAGE ===
const storage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: async (req, file) => {
    const userId = req.user?.uid;
    const applicationId = req.params.id;
    const originalName = path.parse(file.originalname).name;
    const publicId = `${originalName}-${Date.now()}`;
    let folderPath = `grad-tracker/${userId}/${applicationId}`;

    if (!userId || applicationId === "chat") {
      folderPath = `grad-tracker/${userId}/chat-media`;
    } else if (!applicationId) {
      folderPath = "grad-tracker/misc";
    }

    return {
      folder: folderPath,
      public_id: publicId,
      resource_type: "raw",
      format: file.mimetype.split("/")[1],
    };
  },
});
const upload = multer({ storage });

// === KEEP-ALIVE (Render uptime prevention) ===
app.get("/keep-alive", async (req, res) => {
  console.log(`[Keep-Alive] Ping received at: ${new Date().toISOString()}`);

  // List all collections
  const collections = await db.listCollections();
  // const ids = collections.map((col) => col.id);
  // console.log(JSON.stringify(ids, null, 2));
  const snapshot = await collections.at(collections.length - 1).get();

  // All docs as plain objects
  snapshot.docs.forEach((doc) => {
    console.log(doc.id, JSON.stringify(doc.data(), null, 2));
  });

  res.status(200).send("Service is Awake!");
});

// === DOCUMENT UPLOAD ROUTES ==
app.post(
  "/api/applications/:id/documents",
  verifyToken,
  requireSubscriptionAccess,
  upload.single("document"),
  async (req, res) => {
    if (!req.file) return res.status(400).send("No file uploaded.");

    const { id: applicationId } = req.params;
    let { fileType } = req.body;
    const userId = req.user.uid;

    if (!fileType || !userId) {
      if (req.file) {
        cloudinary.uploader.destroy(req.file.filename, {
          resource_type: "raw",
        });
      }
      return res.status(400).send("Missing file type or user ID.");
    }

    // Chat media (skip DB save)
    if (applicationId === "chat") {
      return res.status(201).json({
        fileName: req.file.originalname,
        fileUrl: req.file.path,
        filePublicId: req.file.filename,
        fileType,
      });
    }

    try {
      const newDocument = new Document({
        applicationId,
        userId,
        fileName: req.file.originalname,
        fileUrl: req.file.path,
        filePublicId: req.file.filename,
        fileType,
      });
      await newDocument.save();
      res.status(201).json(newDocument);
    } catch (error) {
      console.error("Document upload error:", error);
      if (req.file)
        cloudinary.uploader.destroy(req.file.filename, {
          resource_type: "raw",
        });
      res.status(500).send("Server error.");
    }
  },
);

// === ROUTES MOUNTING ===
app.use(
  "/api/applications",
  verifyToken,
  requireSubscriptionAccess,
  applicationRoutes,
);
app.use(
  "/api/feedback",
  verifyToken,
  requireSubscriptionAccess,
  feedbackRoutes,
);
app.use("/api/programs", verifyToken, requireSubscriptionAccess, programRoutes);
app.use("/api/emails", verifyToken, requireSubscriptionAccess, emailRoutes);
app.use("/api/admin", verifyToken, adminRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/users", userRoutes);
app.use("/api/mentors", verifyToken, requireSubscriptionAccess, mentorsRouter);
app.use("/api/mentee", verifyToken, requireSubscriptionAccess, menteeRoutes);
app.use(
  "/api/notifications",
  verifyToken,
  requireSubscriptionAccess,
  notificationRoutes,
);
app.use(
  "/api/sopRequestsRoutes",
  verifyToken,
  requireSubscriptionAccess,
  sopRequestsRoutes,
);
app.use(
  "/api/connections",
  verifyToken,
  requireSubscriptionAccess,
  connectionsRoutes,
);
app.use("/api/groups", verifyToken, requireSubscriptionAccess, groupsRoutes);
app.use("/api/agora", verifyToken, requireSubscriptionAccess, agoraRoutes);
app.use("/api/projects", verifyToken, requireSubscriptionAccess, projectRoutes);
app.use(
  "/api/interview-prep",
  verifyToken,
  requireSubscriptionAccess,
  interviewPrepRoutes,
);
app.use("/api/chats", verifyToken, requireSubscriptionAccess, chatRoutes);
app.use(
  "/api/cv-service",
  verifyToken,
  requireSubscriptionAccess,
  cvServiceRoutes,
);
app.use(
  "/api/visa-prep",
  verifyToken,
  requireSubscriptionAccess,
  visaInterviewPrepRoutes,
);
app.use(
  "/api/financial-support",
  verifyToken,
  requireSubscriptionAccess,
  financialSupportRoutes,
);
app.use(
  "/api/program-suggestions",
  verifyToken,
  requireSubscriptionAccess,
  suggestionsRoutes,
);
app.use("/api/v1", verifyToken, requireSubscriptionAccess, aiRoutes);
app.use("/api/welcome", welcomeEmailRoutes);
app.use("/api/push", verifyToken, requireSubscriptionAccess, pushRoutes);
app.use(
  "/api/community",
  verifyToken,
  requireSubscriptionAccess,
  communityRoutes,
);
app.post("/api/payment/webhook", handlePaystackWebhook);
app.use("/api/payment", paymentRoutes);

// === TEST SCRAPER ENDPOINT ===
// Allows manual scraper trigger for testing
app.get("/api/test-scraper", async (req, res) => {
  try {
    await runAllScrapers();
    res
      .status(200)
      .json({ message: "Graduate program scrapers executed successfully." });
  } catch (error) {
    console.error("Scraper test error:", error);
    res
      .status(500)
      .json({ message: "Scraper test failed.", error: error.message });
  }
});

// === ROOT ROUTE ===
app.get("/", (req, res) => {
  res.send(
    "🎓 Grad School Application API is running and connected to Firestore & Cron Jobs!",
  );
});

export default app;

// === START SERVER ===
// const PORT = process.env.PORT || 5000;
// app.listen(PORT, () => console.log(`Server is running on port ${PORT}`));
