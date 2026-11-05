// Firebase Web SDK (compat) — works without npm or a bundler.
// This is a public web-app configuration, NOT a service account key.
const firebaseConfig = {
  apiKey: "AIzaSyDnHAxXtS6wVgLUwjKvSpuaFR2-58bmeHA",
  authDomain: "vista-4292a.firebaseapp.com",
  projectId: "vista-4292a",
  storageBucket: "vista-4292a.firebasestorage.app",
  messagingSenderId: "818970152947",
  appId: "1:818970152947:web:0c539070ef7a552a18cc86"
};
firebase.initializeApp(firebaseConfig);
const vistaAuth = firebase.auth();
const vistaDb = firebase.firestore();

// Separate Firebase Auth instances prevent operator and visitor sessions from
// replacing each other when both pages are opened in the same browser.
const vistaVisitorApp = firebase.initializeApp(firebaseConfig, "vista-visitor");
const vistaVisitorAuth = firebase.auth(vistaVisitorApp);
const vistaVisitorDb = firebase.firestore(vistaVisitorApp);
