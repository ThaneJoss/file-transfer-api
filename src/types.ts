export type Bindings = Env;

export type AppEnv = {
  Bindings: Bindings;
  Variables: {
    auth: {
      userId: string;
      sessionId: string;
    };
  };
};
