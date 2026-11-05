VISTA — Visitor Information & Smart Tracking Application
Firebase-connected visitor and operator website.
START HERE: SETUP_FIREBASE.txt.
The included firestore.rules must be PUBLISHED in Firebase Console.

Files
  index.html / app.js    Visitor portal (check-in, check-out)
  guard.html / guard.js  Operator dashboard
  common.js              Shared time formatting (Malaysia time) and input clean-up
  firebase-config.js     Firebase project settings
  firestore.rules        Database security rules
  style.css              Styles

Operator dashboard
  - Live clock, 3 summary cards (Currently Inside, Checked Out, Total Visits)
  - Each record shows check-in, check-out and time on site; over 8 hours is highlighted
  - Register Walk-in Visitor for visitors without a phone
  - Export to Excel: choose Day / Week / Month / Year / All / Date Range.
    Downloads a formatted .xlsx report (title, period, generated date, summary,
    styled table). Needs internet to load the Excel library; offline it falls
    back to a CSV with the same title block.

One person, one active visit
  - A name cannot check in again until that visit is checked out (from any phone,
    browser, or the guard's walk-in form). Names are compared in capitals with
    extra spaces removed. Check-out by the visitor or the guard releases the name.
  - This uses a small "activeNames" collection in Firestore.
  - IMPORTANT: publish the updated firestore.rules in Firebase Console
    (Firestore Database > Rules > paste > Publish) or check-in will be denied.
