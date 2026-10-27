// The #900 missing-credential error, extracted from the credentials
// monolith's resolver: the ERROR_TABLE shape plus the onboarding hint, with
// scenario routing that reads whether a CodeArts-injected account is
// available.
import { buildOnboardingSteps, makeError, type GuidanceStep } from './error-table.ts';
import { isCodeArtsContext, readCodeArtsCredentials } from './codearts-context.ts';
import { present } from './credential-placeholder.ts';

interface OnboardingHint {
  scenario: number;
  reason: string;
  message: string;
  steps: Array<Record<string, unknown> | GuidanceStep>;
}

// The table error plus the resolver's onboarding hint (#900 shape union).
type MissingCredentialError = ReturnType<typeof makeError> & { onboarding?: OnboardingHint };

// #900: unified guidance — one steps builder shared with computeOnboarding,
// and the error shape from the single ERROR_TABLE. Zero IO beyond the
// readCodeArtsCredentials() probe for scenario routing.
//
// Consumed by the credential resolver's failure path; not part of the face's
// public surface.
export function missingCredentialError(): MissingCredentialError {
  const codeartsCreds = readCodeArtsCredentials();
  const injectedAvailable = present(codeartsCreds?.ak) && present(codeartsCreds?.sk);
  const codearts = isCodeArtsContext();
  const err = makeError('HDKIT_CRED_MISSING') as MissingCredentialError;
  err.onboarding = injectedAvailable
    ? {
        scenario: 4,
        reason: 'import-injected',
        message: '检测到配置中已有有效账号,可导入为正式凭证。',
        steps: buildOnboardingSteps(4, { codearts }),
      }
    : {
        scenario: 3,
        reason: 's1-missing',
        message: '未配置华为云凭证,需要完成登录后才能使用云能力。',
        steps: buildOnboardingSteps(3, { codearts }),
      };
  return err;
}
