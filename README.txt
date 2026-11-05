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

The saved data fields are unchanged, so firestore.rules does not need to be republished.
