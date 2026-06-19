export async function generateRegistrationOptions(options: {
  rpName: string;
  rpID: string;
  userID: Uint8Array;
  userName: string;
  userDisplayName: string;
  authenticatorSelection: Record<string, unknown>;
  excludeCredentials: unknown[];
  extensions?: Record<string, unknown>;
}) {
  return {
    challenge: "registration-challenge",
    rp: { name: options.rpName, id: options.rpID },
    user: {
      id: btoa(String.fromCharCode(...options.userID)),
      name: options.userName,
      displayName: options.userDisplayName,
    },
    pubKeyCredParams: [{ type: "public-key", alg: -7 }],
    timeout: 60_000,
    excludeCredentials: options.excludeCredentials,
    authenticatorSelection: options.authenticatorSelection,
    attestation: "none",
    extensions: options.extensions,
  };
}

export async function generateAuthenticationOptions(options: {
  rpID: string;
  allowCredentials?: unknown[];
  userVerification?: string;
  extensions?: Record<string, unknown>;
}) {
  return {
    challenge: "authentication-challenge",
    rpId: options.rpID,
    allowCredentials: options.allowCredentials ?? [],
    userVerification: options.userVerification ?? "preferred",
    extensions: options.extensions,
  };
}

export async function verifyRegistrationResponse(options: { response: { id: string } }) {
  return {
    verified: true,
    registrationInfo: {
      aaguid: "test-aaguid",
      credentialDeviceType: "singleDevice",
      credentialBackedUp: false,
      credential: {
        id: options.response.id,
        publicKey: new Uint8Array([1, 2, 3]),
        counter: 0,
      },
    },
  };
}

export async function verifyAuthenticationResponse() {
  return {
    verified: true,
    authenticationInfo: {
      newCounter: 1,
      credentialID: "credential-id",
      userVerified: true,
      credentialDeviceType: "singleDevice",
      credentialBackedUp: false,
      origin: "https://file.thanejoss.com",
      rpID: "file.thanejoss.com",
    },
  };
}
