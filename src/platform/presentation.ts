export type NativeAccess = 'available' | 'allowed' | 'unavailable';
export interface Presentation {
  nativeButton: string;
  nativeAllowed: string;
  nativeUnavailable: string;
  nativeDeclined: string;
  onboardingAI: string;
  download: string;
  settingsAI: string;
  runtimePrivacy: string;
  identityPrivacy: string;
  protections: string;
  permissionError: string;
}
