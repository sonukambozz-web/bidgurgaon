/* ================================================================
   PAYMENT CONFIG

   -- UPI / QR (live now) --------------------------------------
   Your real bank-transfer details, used on pages/bid-now.html for
   the QR code, the "Pay via UPI app" deep link, and the bank-
   transfer fallback block. Safe to expose publicly — this is the
   same info printed on your QR poster.

   -- Razorpay (optional, for later) ------------------------------
   Leave RAZORPAY_KEY_ID as-is until you have a Razorpay account.
   Once you do: Dashboard → Settings → API Keys → paste the Key ID
   below (starts with rzp_test_ or rzp_live_). The site will then
   show an additional "Pay by card/netbanking" button automatically.
   NEVER put your Key Secret here or anywhere in this site.
================================================================= */
window.PAYMENT_CONFIG = {
  companyName: "SPY REALTORS",
  upiId: "88065702@idfcbank",
  qrImage: "../img/payment-qr.jpg",
  bank: {
    accountName: "SPY REALTORS",
    accountNumber: "10101372288",
    ifsc: "IDFB0021001",
    swift: "IDFBINBBMUM",
    bankName: "IDFC FIRST Bank",
    branch: "Gurgaon Golf Course Road Branch"
  }
};

window.RAZORPAY_KEY_ID = "YOUR_RAZORPAY_KEY_ID";
