/** Owner sign-in email (05 §3.2). In ENV=test the message goes to an in-memory outbox instead. */
import { ApiError } from '../errors.ts';

export const SENDER = { name: 'Bikri', email: 'bikri@algovyn.com' };

export type OutboxMessage = {
  to: string;
  subject: string;
  text: string;
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
    '',
    '—',
    '',
    `آپ کا بکری سائن اِن کوڈ ${input.code} ہے`,
    '',
    `دکان: ${input.shopName}`,
    `ڈیوائس: ${input.deviceName}`,
    'یہ کوڈ 10 منٹ میں ختم ہو جائے گا۔',
    'اگر آپ نے یہ نہیں مانگا تو اس ای میل کو نظر انداز کریں؛ کوڈ کے بغیر کوئی سائن اِن نہیں کر سکتا۔',
  ].join('\n');
}

export async function sendSigninEmail(
  env: Env,
  to: string,
  input: { code: string; shopName: string; deviceName: string },
): Promise<void> {
  const subject = 'Your Bikri sign-in code';
  const text = signinEmailText(input);
  try {
    if (String(env.ENV) === 'test') {
      if (testMail.fail)
        throw new Error('destination address not verified (test)');
      testOutbox.push({ to, subject, text, at: Date.now() });
      if (testOutbox.length > 200)
        testOutbox.splice(0, testOutbox.length - 200);
      return;
    }
    await env.EMAIL.send({ from: SENDER, to, subject, text });
  } catch (e) {
    console.log(
      JSON.stringify({
        event: 'owner_signin_email_failed',
        error: String((e as Error).message).slice(0, 120),
      }),
    );
    throw new ApiError(
      'EMAIL_UNAVAILABLE',
      503,
      "Email sign-in isn't working for this shop",
    );
  }
}
