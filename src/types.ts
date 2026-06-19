export type Bindings = {
  DB: D1Database;
  BETTER_AUTH_SECRET: string;
  BETTER_AUTH_URL: string;
  APP_ORIGIN?: string;
  TURN_KEY_ID: string;
  TURN_KEY_API_TOKEN: string;
  R2_ACCOUNT_ID: string;
  R2_BUCKET: string;
  R2_PARENT_API_TOKEN: string;
  R2_PARENT_ACCESS_KEY_ID: string;
  SFU_APP_ID: string;
  SFU_APP_TOKEN: string;
};

export type AppEnv = {
  Bindings: Bindings;
  Variables: {
    auth: {
      userId: string;
      sessionId: string;
    };
  };
};
