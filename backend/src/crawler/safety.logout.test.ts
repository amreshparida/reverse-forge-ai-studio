import { describe, expect, it } from 'vitest';
import {
  isSafeExplorationClick,
  isSafeToClick,
  isSessionEndingAction,
  isSessionEndingText,
  isSessionEndingUrl,
  isTextSafe,
  isUrlSafe,
} from './safety';

describe('logout / session-end safety', () => {
  it('blocks common logout button labels', () => {
    for (const label of [
      'Logout',
      'Log out',
      'Log Out',
      'Sign out',
      'Sign Out',
      'Sign-off',
      'End Session',
      'Kill Session',
      'Terminate Session',
      'Force Logout',
      'Log me out',
      'Exit Application',
    ]) {
      expect(isSessionEndingText(label), label).toBe(true);
      expect(isTextSafe(label), label).toBe(false);
      expect(isSafeToClick(label, null), label).toBe(false);
      expect(isSafeExplorationClick(label, null), label).toBe(false);
    }
  });

  it('blocks logout even if listed in safeClickSelectors allow-list', () => {
    expect(isTextSafe('Logout', ['Logout'])).toBe(false);
  });

  it('blocks logout / session-end URLs', () => {
    for (const url of [
      'https://app.example.com/logout',
      'https://app.example.com/ITMS/log-out.get',
      'https://app.example.com/ITMS/logouta.get',
      'https://app.example.com/auth/sign-out',
      'https://app.example.com/session/terminate',
      'https://app.example.com/end-session',
      'https://idp.example.com/SingleLogOut',
    ]) {
      expect(isSessionEndingUrl(url), url).toBe(true);
      expect(isUrlSafe(url, [], []), url).toBe(false);
    }
  });

  it('blocks controls identified by id/class/data-action', () => {
    expect(isSessionEndingAction({
      text: 'Account',
      id: 'btn-logout',
    })).toBe(true);
    expect(isSessionEndingAction({
      text: 'User menu',
      className: 'nav-item sign-out-link',
    })).toBe(true);
    expect(isSessionEndingAction({
      text: 'Power',
      dataAction: 'terminate-session',
    })).toBe(true);
  });

  it('blocks logouta.get style URLs used by ITMS', () => {
    const url = 'https://itrainppe.etihad.ae/ITMS/logouta.get';
    expect(isSessionEndingUrl(url)).toBe(true);
    expect(isUrlSafe(url, ['itrainppe.etihad.ae'], [])).toBe(false);
    expect(isSafeExplorationClick('Logout', url)).toBe(false);
    expect(isSessionEndingAction({ text: 'Logout', href: url })).toBe(true);
  });

  it('allows normal navigation labels', () => {
    for (const label of ['Dashboard', 'Training', 'View details', 'Next', 'Reports']) {
      expect(isSessionEndingText(label), label).toBe(false);
      expect(isTextSafe(label), label).toBe(true);
    }
  });
});
