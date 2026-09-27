/* ================================================================
   FIREBASE CONFIG — paste your Web app SDK keys below.

   Where to get these (you said you already created a Web app):
   Firebase Console → Project settings (gear icon) → scroll to
   "Your apps" → select your Web app → "SDK setup and configuration"
   → "Config". Copy the object it shows you and paste the values
   in below, replacing the YOUR_... placeholders.

   Until real values are pasted in, the site silently keeps using
   data.json (nothing breaks) — see js/firebase-data.js.
================================================================= */
window.FIREBASE_CONFIG = {
  apiKey: "AIzaSyB5eQYqUTj3hI-O0Nkuaj5rF3SLaU8V6NA",
  authDomain: "bidgurgaon.firebaseapp.com",
  projectId: "bidgurgaon",
  storageBucket: "bidgurgaon.firebasestorage.app",
  messagingSenderId: "829036991689",
  appId: "1:829036991689:web:e3a8df17f02a28643a2918"
};

/* Public site reads LIVE data from Firestore (the same store the Admin
   console edits), so admin changes appear on the site. If a Firestore
   read fails or the developers collection is empty, main.js safely
   falls back to data.json — the site never shows a blank board.
   Set back to anything other than 'firestore' to serve data.json only. */
window.GGN_DATA_SOURCE = 'firestore';
