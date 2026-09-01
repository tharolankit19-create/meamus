/* Sign-in / sign-up modal. Resolves to the user, or null if dismissed. */

import { el, icon, modal, toast, withBusy } from './ui.js';
import { auth, setSession, state } from './api.js';

/** Google's mark, inlined: an external image would be blocked or slow. */
function googleMark() {
  return el('span', {
    class: 'gmark',
    html: '<svg viewBox="0 0 18 18" width="16" height="16" aria-hidden="true">'
      + '<path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 01-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62z"/>'
      + '<path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.81.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 009 18z"/>'
      + '<path fill="#FBBC05" d="M3.97 10.72a5.4 5.4 0 010-3.44V4.95H.96a9 9 0 000 8.1l3.01-2.33z"/>'
      + '<path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.46.9 11.43 0 9 0A9 9 0 00.96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58z"/>'
      + '</svg>'
  });
}

export function openAuth(mode = 'login') {
  return new Promise((resolve) => {
    let current = mode;
    let settled = null;
    let done = false;

    // Resolve the moment the account exists, not when the dialog has finished
    // closing. Waiting on the close event meant the caller could not start
    // navigating until the dialog had gone, which is the pause that read as
    // "it logged me in and then jumped somewhere".
    const finish = (user) => {
      if (done) return;
      done = true;
      settled = user;
      resolve(user);
    };

    const { dialog, close } = modal((closeFn) => {
      const title = el('h2', { style: { fontSize: '21px', marginBottom: '4px' } });
      const sub = el('p', { class: 'muted small' });
      const nameField = el('label', { class: 'field' },
        el('span', {}, 'Name'), el('input', { type: 'text', name: 'name', autocomplete: 'name', maxlength: '60' }));
      const emailInput = el('input', { type: 'email', name: 'email', required: true, autocomplete: 'email', placeholder: 'you@studio.com' });
      const passwordInput = el('input', { type: 'password', name: 'password', required: true, minlength: '8', placeholder: 'At least 8 characters' });
      const errorBox = el('p', { class: 'form-error hide' });
      const submit = el('button', { class: 'btn primary block', type: 'submit' });
      const switchBtn = el('button', { class: 'linkbtn', type: 'button' });

      // Google, when the deployment actually offers it. Rendered only after
      // /auth/methods confirms it - a dead button is worse than no button.
      const googleBtn = el('button', {
        class: 'btn block google-btn hide', type: 'button',
        onClick: async () => {
          try {
            const { url } = await auth.google(`${location.origin}/#/auth/callback`);
            location.href = url;
          } catch (err) {
            errorBox.textContent = err.message;
            errorBox.classList.remove('hide');
          }
        }
      }, googleMark(), 'Continue with Google');

      const divider = el('div', { class: 'or-divider hide' }, el('span', {}, 'or'));

      auth.methods().then((m) => {
        if (!m.google) return;
        googleBtn.classList.remove('hide');
        divider.classList.remove('hide');
      }).catch(() => { /* password sign-in still works */ });
      const switchText = el('span', { class: 'muted small' });

      function paint() {
        const isRegister = current === 'register';
        title.textContent = isRegister ? 'Create your account' : 'Welcome back';
        const grant = (state.status && state.status.credits && state.status.credits.signupGrant) || 200;
        sub.textContent = isRegister
          ? `${grant} free credits, no card — enough for about ten games.`
          : 'Sign in to keep building.';
        nameField.classList.toggle('hide', !isRegister);
        passwordInput.autocomplete = isRegister ? 'new-password' : 'current-password';
        submit.textContent = isRegister ? 'Create account' : 'Sign in';
        switchText.textContent = isRegister ? 'Already have an account?' : 'New to meamus?';
        switchBtn.textContent = isRegister ? 'Sign in' : 'Create an account';
        errorBox.classList.add('hide');
      }

      switchBtn.addEventListener('click', () => {
        current = current === 'login' ? 'register' : 'login';
        paint();
      });

      const form = el('form', {
        class: 'dlg',
        onSubmit: async (event) => {
          event.preventDefault();
          submit.disabled = true;
          errorBox.classList.add('hide');
          const release = withBusy(
            submit,
            current === 'register' ? 'Creating account\u2026' : 'Signing in\u2026'
          );
          try {
            const payload = await auth[current]({
              email: emailInput.value,
              password: passwordInput.value,
              name: nameField.querySelector('input').value || undefined
            });

            // An account that needs email confirmation has no session yet.
            if (payload.confirmationRequired) {
              release();
              errorBox.textContent = payload.message
                || 'Account created. Check your email to confirm it, then sign in.';
              errorBox.classList.remove('hide');
              errorBox.classList.add('is-info');
              current = 'login';
              paint();
              errorBox.classList.remove('hide');
              return;
            }

            setSession(payload.token, payload.user);
            // Hand the caller the account first, then close. The dashboard is
            // already rendering behind the dialog as it fades.
            finish(payload.user);
            closeFn();
            toast(current === 'register' ? 'Account created — start building.' : 'Signed in', 'ok');
          } catch (err) {
            // A deployment without durable storage refuses signup on purpose;
            // say so plainly instead of looking like a broken form.
            errorBox.textContent = err.code === 'storage_not_durable'
              ? 'Accounts are off on this deployment, so nothing is locked — close this and start a prompt. Everything is already unlocked for you.'
              : err.message;
            errorBox.classList.remove('hide');
          } finally {
            release();
          }
        }
      },
      el('div', { class: 'row', style: { gap: '9px', marginBottom: '14px' } },
        el('span', { class: 'brand-mark' }, icon('gamepad')),
        el('span', { style: { fontWeight: '640' } }, 'meamus')),
      title, sub,
      el('div', { style: { height: '18px' } }),
      googleBtn,
      divider,
      nameField,
      el('label', { class: 'field' }, el('span', {}, 'Email'), emailInput),
      el('label', { class: 'field' }, el('span', {}, 'Password'), passwordInput),
      errorBox,
      submit,
      el('p', { class: 'center', style: { margin: '14px 0 0' } }, switchText, ' ', switchBtn));

      paint();
      setTimeout(() => emailInput.focus(), 60);
      return form;
    });

    // Dismissing without signing in resolves null.
    dialog.addEventListener('close', () => finish(settled));
    void close;
  });
}
