import webpush from "web-push";

webpush.setVapidDetails(
  "mailto:admin@gradmanagers.com",
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

export default webpush;
