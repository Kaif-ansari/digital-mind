const payButton = document.getElementById("pay-button");
const message = document.getElementById("checkout-message");

payButton.addEventListener("click", async () => {
  payButton.disabled = true;
  payButton.textContent = "Preparing secure checkout...";
  message.textContent = "Creating a server-side Razorpay order.";

  try {
    if (!window.Razorpay) {
      throw new Error("Razorpay Checkout could not be loaded.");
    }

    const configResponse = await fetch("/api/checkout-config", { credentials: "same-origin" });
    const config = await configResponse.json();
    if (!configResponse.ok) throw new Error(config.error || "Checkout is not configured.");

    const orderResponse = await fetch("/api/razorpay/order", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin"
    });
    const order = await orderResponse.json();
    if (!orderResponse.ok) throw new Error(order.error || "Could not create order.");

    const checkout = new window.Razorpay({
      key: config.key_id,
      amount: order.amount,
      currency: order.currency,
      name: "50 Micro SaaS.",
      description: config.name,
      order_id: order.order_id,
      notes: {
        product_id: config.product_id
      },
      handler: async (response) => {
        message.textContent = "Verifying your payment securely.";
        const verifyResponse = await fetch("/api/razorpay/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify(response)
        });
        const verification = await verifyResponse.json();
        if (!verifyResponse.ok || !verification.verified) {
          throw new Error(verification.error || "Payment could not be verified.");
        }
        window.location.href = verification.redirect_url;
      },
      modal: {
        ondismiss: () => {
          payButton.disabled = false;
          payButton.textContent = "Pay with Razorpay →";
          message.textContent = "Checkout was closed before payment was completed.";
        }
      },
      theme: {
        color: "#173f32"
      }
    });

    checkout.open();
  } catch (error) {
    payButton.disabled = false;
    payButton.textContent = "Pay with Razorpay →";
    message.textContent = error.message;
  }
});
