/** Owner sign-in email (05 §3.2). In ENV=test the message goes to an in-memory outbox instead. */
import { ApiError } from '../errors.ts';
import {
  shopInviteEmailHtml,
  signinEmailHtml,
  utcStamp,
} from './emailTemplates.ts';

export const SENDER = { name: 'Bikri', email: 'bikri@algovyn.com' };

export type OutboxMessage = {
  to: string;
  subject: string;
  text: string;
  html: string;
  at: number;
};
export const testOutbox: OutboxMessage[] = [];
/** Test hook: make the next sends fail like an unverified address. */
export const testMail = { fail: false };

export function signinEmailText(input: {
  code: string;
  shopName: string;
  deviceName: string;
}): string {
  return [
    `Your Bikri sign-in code is ${input.code}`,
    '',
    `Shop: ${input.shopName}`,
    `Device: ${input.deviceName}`,
    'The code expires in 10 minutes.',
    'If you did not ask for this, ignore this email; nobody can sign in without the code.',
    'Bikri will never ask you to share this code.',
  ].join('\n');
}

export function shopInviteEmailText(input: {
  shopName: string;
  code: string;
  link: string;
  expiresAt: number;
}): string {
  const expires = utcStamp(input.expiresAt);
  return [
    `Your shop ${input.shopName} is approved for Bikri.`,
    '',
    `Registration code: ${input.code}`,
    `Open this link on the first till: ${input.link}`,
    `The code expires in 72 hours (${expires}).`,
    'The first device becomes the admin device. Complete the setup wizard to start selling.',
    'If you did not request this, ignore this email.',
  ].join('\n');
}

export async function sendShopInviteEmail(
  env: Env,
  to: string,
  input: {
    shopName: string;
    code: string;
    link: string;
    expiresAt: number;
  },
): Promise<boolean> {
  const subject = 'Your Bikri shop is approved';
  const text = shopInviteEmailText(input);
  const html = shopInviteEmailHtml(input);
  try {
    if (String(env.ENV) === 'test') {
      if (testMail.fail)
        throw new Error('destination address not verified (test)');
      testOutbox.push({ to, subject, text, html, at: Date.now() });
      if (testOutbox.length > 200)
        testOutbox.splice(0, testOutbox.length - 200);
      return true;
    }
    await env.EMAIL.send({ from: SENDER, to, subject, text, html });
    return true;
  } catch (e) {
    const code =
      (e as { code?: unknown }).code ??
      (e as { name?: unknown }).name ??
      'EMAIL_SEND_FAILED';
    console.log(
      JSON.stringify({
        event: 'shop_invite_email_failed',
        code: String(code).slice(0, 40),
      }),
    );
    return false;
  }
}

export async function sendSigninEmail(
  env: Env,
  to: string,
  input: { code: string; shopName: string; deviceName: string },
): Promise<void> {
  const subject = 'Your Bikri sign-in code';
  const text = signinEmailText(input);
  const html = signinEmailHtml(input);
  try {
    if (String(env.ENV) === 'test') {
      if (testMail.fail)
        throw new Error('destination address not verified (test)');
      testOutbox.push({ to, subject, text, html, at: Date.now() });
      if (testOutbox.length > 200)
        testOutbox.splice(0, testOutbox.length - 200);
      return;
    }
    await env.EMAIL.send({ from: SENDER, to, subject, text, html });
  } catch (e) {
    // Provider errors can echo the destination address; log only a bounded code.
    const code =
      (e as { code?: unknown }).code ??
      (e as { name?: unknown }).name ??
      'EMAIL_SEND_FAILED';
    console.log(
      JSON.stringify({
        event: 'owner_signin_email_failed',
        code: String(code).slice(0, 40),
      }),
    );
    throw new ApiError(
      'EMAIL_UNAVAILABLE',
      503,
      "Email sign-in isn't working for this shop",
    );
  }
}
