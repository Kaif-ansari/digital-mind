(async function verifyPurchase() {
  const params = new URLSearchParams(window.location.search);
  const sessionId = params.get("session_id");
  const badge = document.getElementById("status-badge");
  const message = document.getElementById("status-message");
  const button = document.getElementById("download-button");

  try {
    const response = await fetch(`/api/purchase-status${sessionId ? `?session_id=${encodeURIComponent(sessionId)}` : ""}`, {
      credentials: "same-origin"
    });
    const result = await response.json();

    if (result.verified) {
      badge.textContent = "PAYMENT SUCCESSFUL";
      message.textContent = 'Thank you for your purchase. Your copy of "50 Micro SaaS You Can Build Without Coding" is ready.';
      button.classList.remove("disabled");
      button.removeAttribute("aria-disabled");
      return;
    }

    badge.textContent = "PAYMENT NOT VERIFIED";
    badge.classList.remove("success");
    badge.classList.add("warning");
    message.textContent = result.message || "Your purchase could not be verified.";
    button.remove();
  } catch (error) {
    badge.textContent = "VERIFICATION ERROR";
    badge.classList.remove("success");
    badge.classList.add("warning");
    message.textContent = "Payment could not be verified. Please refresh this page after a moment.";
    button.remove();
  }
})();
