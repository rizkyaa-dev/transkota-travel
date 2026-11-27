/**
 * Client-side controller untuk halaman pembayaran QRIS (double-submit guard + countdown + polite auto-sync).
 */
document.addEventListener('DOMContentLoaded', () => {
  // Guard anti double-click pada form QRIS (inisiasi, cek status, batal)
  document.querySelectorAll('form[data-single-submit]').forEach((form) => {
    form.addEventListener('submit', (event) => {
      if (form.dataset.submitted === 'true') {
        event.preventDefault();
        return;
      }
      form.dataset.submitted = 'true';
      const btn = form.querySelector('button[type="submit"]');
      if (btn) {
        btn.disabled = true;
        btn.classList.add('opacity-60', 'cursor-not-allowed');
        const busyText = form.getAttribute('data-single-submit');
        if (busyText) {
          btn.textContent = busyText;
        }
      }
    });
  });

  const container = document.getElementById('qris-live-panel');
  if (!container) return;

  const statusUrl = container.getAttribute('data-status-url');
  const invoiceUrl = container.getAttribute('data-invoice-url');
  const expiresAtIso = container.getAttribute('data-expires-at');
  const countdownEl = document.getElementById('qris-countdown');
  const liveStatusEl = document.getElementById('qris-live-status');
  const copyUrlBtn = document.getElementById('copy-qris-url-btn');
  const qrUrlInput = document.getElementById('qris-simulator-url');

  if (copyUrlBtn && qrUrlInput) {
    copyUrlBtn.addEventListener('click', async () => {
      const value = qrUrlInput.getAttribute('value') || qrUrlInput.value || '';
      if (!value) return;
      try {
        await navigator.clipboard.writeText(value);
        const prev = copyUrlBtn.textContent;
        copyUrlBtn.textContent = 'URL QRIS Disalin';
        setTimeout(() => {
          copyUrlBtn.textContent = prev || 'Salin URL QR';
        }, 2000);
      } catch {
        qrUrlInput.select?.();
      }
    });
  }

  let pollTimer = null;
  let countdownTimer = null;
  let isChecking = false;

  const stopAllTimers = () => {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    if (countdownTimer) {
      clearInterval(countdownTimer);
      countdownTimer = null;
    }
  };

  if (expiresAtIso && countdownEl) {
    const expiryMs = new Date(expiresAtIso).getTime();
    const updateCountdown = () => {
      const diff = expiryMs - Date.now();
      if (diff <= 0) {
        countdownEl.textContent = '00:00';
        if (liveStatusEl) {
          liveStatusEl.textContent = 'Waktu QRIS berakhir. Buat ulang QRIS atau cek status.';
        }
        if (countdownTimer) {
          clearInterval(countdownTimer);
          countdownTimer = null;
        }
        return;
      }
      const totalSec = Math.floor(diff / 1000);
      const mins = String(Math.floor(totalSec / 60)).padStart(2, '0');
      const secs = String(totalSec % 60).padStart(2, '0');
      countdownEl.textContent = `${mins}:${secs}`;
    };
    updateCountdown();
    countdownTimer = setInterval(updateCountdown, 1000);
  }

  const pollStatus = async () => {
    if (!statusUrl || isChecking || document.hidden) return;
    isChecking = true;
    try {
      const res = await fetch(statusUrl, {
        headers: { Accept: 'application/json' },
        credentials: 'same-origin',
      });
      if (!res.ok) return;
      const json = await res.json();
      const data = json && json.data ? json.data : json;
      if (!data) return;

      if (data.bookingStatus === 'lunas' || data.normalizedStatus === 'settled') {
        stopAllTimers();
        if (liveStatusEl) {
          liveStatusEl.textContent = 'Pembayaran terkonfirmasi! Mengalihkan ke e-tiket...';
        }
        if (invoiceUrl) {
          window.location.href = invoiceUrl;
        }
        return;
      }

      if (
        data.normalizedStatus === 'expired' ||
        data.normalizedStatus === 'cancelled' ||
        data.normalizedStatus === 'denied'
      ) {
        stopAllTimers();
        if (liveStatusEl) {
          liveStatusEl.textContent = `Status QRIS: ${data.normalizedStatus.toUpperCase()}. Muat ulang untuk membuat QR baru.`;
        }
      }
    } catch {
      // Jaringan sementara gagal; polling berikutnya akan mencoba lagi
    } finally {
      isChecking = false;
    }
  };

  if (statusUrl) {
    pollTimer = setInterval(pollStatus, 5000);
  }
});
