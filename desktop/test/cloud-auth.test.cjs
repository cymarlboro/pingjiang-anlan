"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  CloudAuth,
  PROJECT_URL,
  PUBLISHABLE_KEY,
  ALLOWED_PATHS
} = require("../src/main/cloud-auth.cjs");
const { BridgeService, METHODS } = require("../src/main/bridge.cjs");

function fakeSessionStore() {
  let raw = null;
  return {
    load: async () => (raw ? JSON.parse(raw) : null),
    save: async (value) => { raw = value; },
    clear: async () => { raw = null; },
    raw: () => raw
  };
}

test("sign in returns sanitized status and never stores the password", async () => {
  const store = fakeSessionStore();
  const calls = [];
  const auth = new CloudAuth({
    sessionStore: store,
    http: async (options) => {
      calls.push(options);
      return {
        status: 200,
        body: JSON.stringify({
          access_token: "access-secret",
          refresh_token: "refresh-secret",
          expires_in: 3600,
          user: { id: "user-1", email: "a@example.com" }
        })
      };
    }
  });
  const status = await auth.signIn({ email: "a@example.com", password: "password123" });
  assert.equal(status.loggedIn, true);
  assert.equal(status.userId, "user-1");
  assert.equal(status.email, "a@example.com");
  assert.equal(Object.prototype.hasOwnProperty.call(status, "access_token"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(status, "refreshToken"), false);
  assert.equal(JSON.stringify(status).includes("password123"), false);
  assert.equal(calls[0].url, `${PROJECT_URL}/auth/v1/token?grant_type=password`);
  assert.equal(calls[0].headers.Authorization, undefined);
  assert.equal(store.raw().includes("password123"), false);
  assert.equal(store.raw().includes("access-secret"), true);
});

test("status refreshes /user and never returns raw tokens", async () => {
  const store = fakeSessionStore();
  const calls = [];
  const auth = new CloudAuth({
    sessionStore: store,
    http: async (options) => {
      calls.push(options);
      if (options.url.endsWith("/auth/v1/user")) {
        return { status: 200, body: JSON.stringify({ id: "user-1", email: "a@example.com" }) };
      }
      return {
        status: 200,
        body: JSON.stringify({
          access_token: "access-secret",
          refresh_token: "refresh-secret",
          expires_in: 3600,
          user: { id: "user-1", email: "a@example.com" }
        })
      };
    }
  });
  await auth.signIn({ email: "a@example.com", password: "password123" });
  const status = await auth.status();
  assert.equal(status.loggedIn, true);
  assert.equal(JSON.stringify(status).includes("secret"), false);
  assert.equal(calls.some((call) => call.url.endsWith("/auth/v1/user")), true);
  const userCall = calls.find((call) => call.url.endsWith("/auth/v1/user"));
  assert.equal(userCall.headers.Authorization, "Bearer access-secret");
});

test("bad credentials produce a fixed error without upstream text", async () => {
  const auth = new CloudAuth({
    sessionStore: fakeSessionStore(),
    http: async () => ({
      status: 401,
      body: JSON.stringify({ message: "invalid password password123 sk-secret" })
    })
  });
  await assert.rejects(
    () => auth.signIn({ email: "a@example.com", password: "password123" }),
    (error) => {
      assert.equal(error.message, "邮箱或密码不正确");
      assert.equal(error.message.includes("password123"), false);
      return true;
    }
  );
});

test("signup requiring email confirmation stores only a pending email marker", async () => {
  const store = fakeSessionStore();
  const auth = new CloudAuth({
    sessionStore: store,
    http: async () => ({
      status: 200,
      body: JSON.stringify({ user: { id: "user-2", email: "b@example.com" } })
    })
  });
  const status = await auth.signUp({ email: "b@example.com", password: "password123" });
  assert.equal(status.loggedIn, false);
  assert.equal(status.needsEmailConfirmation, true);
  assert.equal(status.email, "b@example.com");
  assert.equal(store.raw().includes("password123"), false);
  assert.equal(store.raw().includes("access_token"), true);
});

test("sign out clears local tokens even when remote revoke fails", async () => {
  const store = fakeSessionStore();
  let mode = "signin";
  const auth = new CloudAuth({
    sessionStore: store,
    http: async () => {
      if (mode === "signin") {
        return {
          status: 200,
          body: JSON.stringify({
            access_token: "access-secret",
            refresh_token: "refresh-secret",
            expires_in: 3600,
            user: { id: "user-1", email: "a@example.com" }
          })
        };
      }
      return { status: 500, body: "server error" };
    }
  });
  await auth.signIn({ email: "a@example.com", password: "password123" });
  mode = "signout";
  const status = await auth.signOut();
  assert.equal(status.loggedIn, false);
  assert.match(status.error, /撤销未完成/);
  assert.equal(store.raw(), null);
});

test("real GoTrue REST signup returns a root user without a session", async () => {
  const store=fakeSessionStore();
  const auth=new CloudAuth({sessionStore:store,http:async()=>({status:200,body:JSON.stringify({
    id:'a8fd804c-c10b-4b11-8342-b41c749b053a',aud:'authenticated',email:'b@example.com',
    confirmation_sent_at:'2026-10-22T13:00:00Z',identities:[]
  })})});
  const status=await auth.signUp({email:'b@example.com',password:'password123'});
  assert.equal(status.loggedIn,false);
  assert.equal(status.needsEmailConfirmation,true);
  assert.equal(status.email,'b@example.com');
  assert.equal(store.raw().includes('password123'),false);
});

test("verifyOtp posts the signup OTP without a session Authorization header", async () => {
  const store = fakeSessionStore();
  const calls = [];
  const auth = new CloudAuth({
    sessionStore: store,
    http: async (options) => {
      calls.push(options);
      return {
        status: 200,
        body: JSON.stringify({
          access_token: "verified-access",
          refresh_token: "verified-refresh",
          expires_in: 3600,
          user: { id: "user-3", email: "otp@example.com" }
        })
      };
    }
  });
  const status = await auth.verifyOtp({ email: "otp@example.com", token: "482913" });
  assert.equal(status.loggedIn, true);
  assert.equal(status.userId, "user-3");
  assert.equal(status.email, "otp@example.com");
  assert.equal(status.needsEmailConfirmation, false);
  assert.equal(JSON.stringify(status).includes("verified-access"), false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].url, `${PROJECT_URL}/auth/v1/verify`);
  assert.equal(calls[0].headers.Authorization, undefined);
  assert.equal(calls[0].headers.apikey, PUBLISHABLE_KEY);
  assert.deepEqual(JSON.parse(calls[0].body), {
    email: "otp@example.com",
    token: "482913",
    type: "signup"
  });
  assert.equal(store.raw().includes("verified-access"), true);
  assert.equal(store.raw().includes("482913"), false);
  assert.equal(store.raw().includes("otp@example.com"), true);
  assert.equal(store.raw().includes("needs_email_confirmation"), true);
});

test("verifyOtp validates email and 6-10 numeric digits before any request", async () => {
  const calls = [];
  const auth = new CloudAuth({
    sessionStore: fakeSessionStore(),
    http: async (options) => {
      calls.push(options);
      return { status: 200, body: "{}" };
    }
  });
  const badTokens = [
    "",
    "12345",
    "12345678901",
    "abcdef",
    "12345a",
    "123 456"
  ];
  for (const token of badTokens) {
    await assert.rejects(
      () => auth.verifyOtp({ email: "otp@example.com", token }),
      /验证码/
    );
  }
  await assert.rejects(
    () => auth.verifyOtp({ email: "not-an-email", token: "482913" }),
    /邮箱格式不正确/
  );
  await assert.rejects(
    () => auth.verifyOtp({ email: "otp@example.com", token: 482913 }),
    /验证码/
  );
  assert.equal(calls.length, 0);
});

test("verifyOtp failure keeps the pending marker and never reflects upstream text", async () => {
  const store = fakeSessionStore();
  const pending = {
    access_token: "",
    refresh_token: "",
    expires_at: 0,
    user_id: "",
    email: "otp@example.com",
    needs_email_confirmation: true,
    pending_email: "otp@example.com",
    had_session: false
  };
  await store.save(JSON.stringify(pending));
  const before = store.raw();
  const auth = new CloudAuth({
    sessionStore: store,
    http: async () => ({
      status: 403,
      body: JSON.stringify({
        error_code: "otp_expired",
        message: "raw upstream secret body 482913"
      })
    })
  });
  await assert.rejects(
    () => auth.verifyOtp({ email: "otp@example.com", token: "482913" }),
    (error) => {
      assert.match(error.message, /验证码已过期/);
      assert.equal(error.message.includes("raw upstream secret body"), false);
      assert.equal(error.message.includes("482913"), false);
      return true;
    }
  );
  assert.equal(store.raw(), before);
  assert.equal(JSON.parse(store.raw()).needs_email_confirmation, true);
});

test("resendSignup posts type=signup without Authorization and returns a pending status", async () => {
  const store = fakeSessionStore();
  const calls = [];
  const auth = new CloudAuth({
    sessionStore: store,
    http: async (options) => {
      calls.push(options);
      return { status: 200, body: "{}" };
    }
  });
  const status = await auth.resendSignup({ email: "otp@example.com" });
  assert.equal(status.loggedIn, false);
  assert.equal(status.needsEmailConfirmation, true);
  assert.equal(status.email, "otp@example.com");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].url, `${PROJECT_URL}/auth/v1/resend`);
  assert.equal(calls[0].headers.Authorization, undefined);
  assert.equal(calls[0].headers.apikey, PUBLISHABLE_KEY);
  assert.deepEqual(JSON.parse(calls[0].body), {
    type: "signup",
    email: "otp@example.com"
  });
  // Resending never writes a session or marks confirmation locally.
  assert.equal(store.raw(), null);
});

test("signup and resend map known SMTP failures to fixed operator guidance", async () => {
  const cases = [
    {
      status: 500,
      code: "email_address_not_authorized",
      expected: /自定义 SMTP/
    },
    {
      status: 500,
      code: "email_send_failed",
      expected: /email_send_failed/
    },
    {
      status: 500,
      code: "unexpected_failure",
      expected: /unexpected_failure/
    }
  ];
  for (const item of cases) {
    const auth = new CloudAuth({
      sessionStore: fakeSessionStore(),
      http: async () => ({
        status: item.status,
        body: JSON.stringify({
          error_code: item.code,
          message: "raw-body-must-not-appear"
        })
      })
    });
    await assert.rejects(
      () => auth.signUp({ email: "otp@example.com", password: "password123" }),
      (error) => {
        assert.match(error.message, item.expected);
        assert.match(error.message, /HTTP 500/);
        assert.equal(error.message.includes(item.code), true);
        assert.equal(error.message.includes("raw-body-must-not-appear"), false);
        assert.match(error.message, /SMTP|邮件服务配置/);
        return true;
      }
    );
    await assert.rejects(
      () => auth.resendSignup({ email: "otp@example.com" }),
      (error) => {
        assert.match(error.message, item.expected);
        assert.equal(error.message.includes("raw-body-must-not-appear"), false);
        return true;
      }
    );
  }
});

test("generic DB 500 is not misdiagnosed as a mail configuration problem", async () => {
  const auth = new CloudAuth({
    sessionStore: fakeSessionStore(),
    http: async () => ({
      status: 500,
      body: JSON.stringify({
        error_code: "database_error",
        message: "connection refused to db host"
      })
    })
  });
  await assert.rejects(
    () => auth.signUp({ email: "otp@example.com", password: "password123" }),
    (error) => {
      assert.equal(error.message, "云端服务暂时不可用，请稍后再试");
      assert.equal(error.message.includes("SMTP"), false);
      assert.equal(error.message.includes("database_error"), false);
      return true;
    }
  );
});

test("verify and resend paths are allowlisted and bridged", async () => {
  assert.equal(ALLOWED_PATHS.has("/auth/v1/verify"), true);
  assert.equal(ALLOWED_PATHS.has("/auth/v1/resend"), true);
  for (const method of ["cloudVerifyOtp", "cloudResendSignup"]) {
    assert.equal(METHODS.has(method), true);
  }
  const calls = [];
  const bridge = new BridgeService({
    cloudAuth: {
      verifyOtp: async (data) => {
        calls.push(["verify", data]);
        return { loggedIn: true, needsEmailConfirmation: false };
      },
      resendSignup: async (data) => {
        calls.push(["resend", data]);
        return { loggedIn: false, needsEmailConfirmation: true };
      }
    }
  });
  assert.deepEqual(
    await bridge.dispatch("cloudVerifyOtp", { email: "otp@example.com", token: "482913" }),
    { loggedIn: true, needsEmailConfirmation: false }
  );
  assert.deepEqual(
    await bridge.dispatch("cloudResendSignup", { email: "otp@example.com" }),
    { loggedIn: false, needsEmailConfirmation: true }
  );
  assert.deepEqual(calls, [
    ["verify", { email: "otp@example.com", token: "482913" }],
    ["resend", { email: "otp@example.com" }]
  ]);
  await assert.rejects(
    () => bridge.dispatch("cloudVerifyOtpWithToken", {}),
    /不支持的方法/
  );
});
