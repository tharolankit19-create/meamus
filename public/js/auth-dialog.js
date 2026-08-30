/* Sign-in / sign-up modal. Resolves to the user, or null if dismissed. */

import { el, icon, modal, toast } from './ui.js';
import { auth, setSession } from './api.js';

export function openAuth(mode = 'login') {
  return new Promise((resolve) => {
    let current = mode;
    let settled = null;

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
      const switchText = el('span', { class: 'muted small' });

      function paint() {
        const isRegister = current === 'register';
        title.textContent = isRegister ? 'Create your account' : 'Welcome back';
        sub.textContent = isRegister
          ? 'Free plan, no card. Your games are saved to your account.'
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
          try {
            const payload = await auth[current]({
              email: emailInput.value,
              password: passwordInput.value,
              name: nameField.querySelector('input').value || undefined
            });
            setSession(payload.token, payload.user);
            settled = payload.user;
            toast(current === 'register' ? 'Account created — start building.' : 'Signed in', 'ok');
            closeFn();
          } catch (err) {
            errorBox.textContent = err.message;
            errorBox.classList.remove('hide');
          } finally {
            submit.disabled = false;
          }
        }
      },
      el('div', { class: 'row', style: { gap: '9px', marginBottom: '14px' } },
        el('span', { class: 'brand-mark' }, icon('gamepad')),
        el('span', { style: { fontWeight: '640' } }, 'meamus')),
      title, sub,
      el('div', { style: { height: '18px' } }),
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

    dialog.addEventListener('close', () => resolve(settled));
    void close;
  });
}
