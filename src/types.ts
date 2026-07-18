export type Bindings = Env;

export type AppEnv = {
  Bindings: Bindings;
  Variables: {
    auth: {
      userId: string;
      sessionId: string;
      kind: "session";
    } | {
      userId: string;
      sessionId: string;
      kind: "guest";
      pickupCode: string;
      expiresAt: number;
    };
  };
};
