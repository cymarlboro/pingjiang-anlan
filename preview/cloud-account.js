/*
 * 平江安澜 · 云端账户（可选登录）
 *
 * 这个模块只负责“我的”页面里的账户卡片。真正的网络请求、令牌保存和会话刷新
 * 全部由安装版原生层完成（cloudAuthStatus / cloudSignIn / cloudSignUp /
 * cloudVerifyOtp / cloudResendSignup / cloudSignOut）。网页不发起网络请求，
 * 不读写浏览器存储，也不接触访问令牌、刷新令牌或密码。
 *
 * 网页预览显示“仅安装版可登录”，不会伪造登录成功；未登录也完全不影响离线
 * 学习记录。
 */
(function (root, factory) {
  "use strict";
  var api = factory(root);
  if (typeof module === "object" && module && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.StudyCloudAccount = api;
  }
})(typeof window !== "undefined" ? window : globalThis, function (root) {
  "use strict";

  // 只允许这六个原生方法；任何其他方法名都会被拒绝。
  var METHOD_TIMEOUTS = Object.freeze({
    cloudAuthStatus: 120000,
    cloudSignIn: 60000,
    cloudSignUp: 60000,
    cloudVerifyOtp: 60000,
    cloudResendSignup: 60000,
    cloudSignOut: 60000
  });
  var STATUS_FRESH_MS = 15000;
  var RESEND_COOLDOWN_MS = 60000;
  var OTP_PATTERN = /^[0-9]{6,10}$/;

  var lastStatus = null;
  var lastStatusAt = 0;
  var statusInFlight = null;

  function getNativeApp() {
    var app = root && root.NativeApp;
    if (!app || app.hasBridge !== true || typeof app.call !== "function") {
      return null;
    }
    return app;
  }

  function isNative() {
    return Boolean(getNativeApp());
  }

  function isPlainObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }

  function safeString(value, max) {
    return String(value === null || value === undefined ? "" : value)
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .trim()
      .slice(0, max || 160);
  }

  function sanitizeStatus(raw) {
    if (!isPlainObject(raw)) {
      return null;
    }
    // 只挑出明确的展示字段。令牌、角色、metadata 等即使被误传也不会进入 UI。
    return {
      configured: raw.configured === true,
      loggedIn: raw.loggedIn === true,
      userId: safeString(raw.userId, 128),
      email: safeString(raw.email, 254),
      needsEmailConfirmation: raw.needsEmailConfirmation === true,
      error: safeString(raw.error, 160)
    };
  }

  function nativeErrorMessage(error) {
    var message = error && error.message ? error.message : error;
    var text = safeString(message, 160);
    return text || "操作未完成，请稍后重试。";
  }

  function rejected(message) {
    var error = new Error(message);
    error.code = "cloud_unavailable";
    return Promise.reject(error);
  }

  function callNative(method, payload) {
    if (!Object.prototype.hasOwnProperty.call(METHOD_TIMEOUTS, method)) {
      return rejected("不支持的云端账户操作。");
    }
    var app = getNativeApp();
    if (!app) {
      return rejected("当前为网页预览，安装版功能不可用。");
    }
    try {
      return Promise.resolve(app.call(method, payload || {}, {
        timeoutMs: METHOD_TIMEOUTS[method]
      }));
    } catch (error) {
      return Promise.reject(error);
    }
  }

  function loadStatus(force) {
    if (!isNative()) {
      return Promise.resolve(null);
    }
    if (!force && lastStatus && Date.now() - lastStatusAt < STATUS_FRESH_MS) {
      return Promise.resolve(lastStatus);
    }
    if (statusInFlight) {
      return statusInFlight;
    }
    statusInFlight = callNative("cloudAuthStatus", {}).then(function (raw) {
      statusInFlight = null;
      var status = sanitizeStatus(raw);
      if (!status) {
        throw new Error("安装版返回的账户状态格式不正确。");
      }
      lastStatus = status;
      lastStatusAt = Date.now();
      return status;
    }, function (error) {
      statusInFlight = null;
      throw error;
    });
    return statusInFlight;
  }

  function el(tag, attributes, children) {
    var node = root.document.createElement(tag);
    if (attributes) {
      Object.keys(attributes).forEach(function (key) {
        var value = attributes[key];
        if (value === null || value === undefined || value === false) {
          return;
        }
        if (key === "class") {
          node.className = String(value);
        } else if (key === "text") {
          node.textContent = String(value);
        } else if (key === "value") {
          node.value = value;
        } else if (key === "disabled" || key === "hidden") {
          node[key] = Boolean(value);
        } else {
          node.setAttribute(key, value === true ? "" : String(value));
        }
      });
    }
    (Array.isArray(children) ? children : (children === undefined ? [] : [children]))
      .forEach(function (child) {
        if (child === null || child === undefined || child === false) {
          return;
        }
        if (typeof child === "string" || typeof child === "number") {
          node.appendChild(root.document.createTextNode(String(child)));
        } else {
          node.appendChild(child);
        }
      });
    return node;
  }

  function notice(text, isError, live) {
    return el("p", {
      class: isError ? "notice is-error" : "notice is-info",
      role: isError ? "alert" : null,
      "aria-live": live || null,
      text: text
    });
  }

  function field(labelText, input) {
    var wrapper = el("div", { class: "filter-field is-wide" });
    wrapper.appendChild(el("label", {
      class: "field-label",
      for: input.id,
      text: labelText
    }));
    wrapper.appendChild(input);
    return wrapper;
  }

  function render() {
    if (!root || !root.document) {
      return null;
    }
    var section = el("section", {
      class: "section",
      "aria-labelledby": "cloud-account-title"
    });
    section.appendChild(el("h3", {
      class: "section-heading",
      id: "cloud-account-title",
      text: "云端账户"
    }));
    section.appendChild(el("p", {
      class: "section-copy",
      text: "可选登录，为后续云端资料功能准备。不登录也能完整使用本机复习；" +
        "离线学习记录不会被清除、替换或上传。"
    }));

    var statusHost = el("div", { class: "cloud-account-status" });
    section.appendChild(statusHost);

    if (!isNative()) {
      statusHost.appendChild(notice(
        "仅安装版可登录。网页预览不提供邮箱密码登录，也不会发送网络请求；" +
        "本机学习记录不受影响。",
        false
      ));
      statusHost.appendChild(el("p", {
        class: "tiny-note",
        text: "安装后可在“我的”页面选择登录；登录始终是可选的。"
      }));
      return section;
    }

    var local = {
      busy: false,
      busyAction: "",
      error: "",
      info: "",
      email: lastStatus ? lastStatus.email : "",
      otp: "",
      resendAvailableAt: 0,
      resendTimer: null
    };

    function draw() {
      statusHost.textContent = "";
      var status = lastStatus;
      var displayError = local.error || (status && status.error) || "";

      if (displayError) {
        statusHost.appendChild(notice(
          displayError,
          !status || !status.loggedIn,
          "polite"
        ));
      }
      if (local.info) {
        statusHost.appendChild(notice(local.info, false, "polite"));
      }

      if (!status) {
        if (!displayError && !local.info) {
          statusHost.appendChild(el("p", {
            class: "section-copy",
            text: local.busy ? "正在处理云端账户…" : "正在读取云端账户状态…"
          }));
        }
        return;
      }

      if (!status.configured) {
        statusHost.appendChild(notice("云端账户尚未配置，暂不可用。", true));
        return;
      }

      if (status.needsEmailConfirmation && !status.loggedIn) {
        var pendingEmail = status.email || local.email || "";
        statusHost.appendChild(notice(
          (pendingEmail ? pendingEmail + "：" : "") +
          "注册请求已提交，请查收确认邮件。确认链接可能已经生效，只是跳转页面打不开；" +
          "如果链接无法打开，请直接用邮箱和密码尝试登录。",
          false,
          "polite"
        ));
        statusHost.appendChild(el("p", {
          class: "tiny-note",
          text: "如果邮件中有验证码，也可以在下方手动输入完成确认。验证码是否出现，取决于管理员" +
            "是否配置了 Supabase 自定义 SMTP 以及确认邮件模板是否包含验证码；" +
            "没有验证码时请继续使用邮件里的确认链接。"
        }));

        var otpInput = el("input", {
          class: "account-input",
          id: "cloud-account-otp",
          type: "text",
          inputmode: "numeric",
          autocomplete: "one-time-code",
          autocapitalize: "off",
          spellcheck: "false",
          maxlength: "10",
          pattern: "[0-9]{6,10}",
          value: local.otp,
          placeholder: "邮件中的 6-10 位数字验证码",
          "aria-label": "邮箱验证码"
        });
        otpInput.addEventListener("input", function () {
          local.otp = String(otpInput.value || "").replace(/[^0-9]/g, "").slice(0, 10);
          otpInput.value = local.otp;
        });

        var otpField = field("邮箱验证码（可选）", otpInput);
        statusHost.appendChild(otpField);

        var confirmButton = el("button", {
          class: "primary-button",
          type: "button",
          id: "cloud-account-confirm",
          text: local.busyAction === "verify" ? "正在确认…" : "确认邮箱",
          disabled: local.busy
        });
        confirmButton.addEventListener("click", function () {
          verifyEmail(pendingEmail, otpInput);
        });

        var remaining = resendRemainingSeconds();
        var resendButton = el("button", {
          class: "secondary-button",
          type: "button",
          id: "cloud-account-resend",
          text: local.busyAction === "resend"
            ? "正在发送…"
            : (remaining > 0 ? "已发送， " + remaining + " 秒后可重发" : "重新发送确认邮件"),
          disabled: local.busy || remaining > 0
        });
        resendButton.addEventListener("click", function () {
          resendConfirmation(pendingEmail);
        });

        statusHost.appendChild(el("div", { class: "account-row" }, [
          confirmButton,
          resendButton
        ]));
        statusHost.appendChild(el("p", {
          class: "tiny-note",
          text: "验证码为 6-10 位数字；重发按钮 60 秒内只能使用一次。只有服务端验证成功并返回" +
            "可用会话后才会保存登录状态，本机不会提前标记为已确认，也不会自动上传或同步学习记录。"
        }));
        scheduleResendRefresh();
      }

      if (status.loggedIn) {
        statusHost.appendChild(el("p", {
          class: "section-copy",
          text: "已登录" + (status.email ? "：" + status.email : "") +
            "。默认与本机学习记录相互独立；只有手动开启跨设备同步后才会共享学习数据。"
        }));
        statusHost.appendChild(el("p", {
          class: "tiny-note",
          text: "网页不会显示或保存访问令牌；退出登录会清除本机令牌，并由安装版尽力撤销云端会话。"
        }));
        var signOutButton = el("button", {
          class: "secondary-button",
          type: "button",
          id: "cloud-account-signout",
          text: local.busy ? "正在退出…" : "退出登录",
          disabled: local.busy
        });
        signOutButton.addEventListener("click", function () {
          if (local.busy) {
            return;
          }
          signOut();
        });
        var row = el("div", { class: "account-row" });
        row.appendChild(el("div", {}, [
          el("span", {
            class: "field-label",
            text: status.email || "当前账户"
          })
        ]));
        row.appendChild(signOutButton);
        statusHost.appendChild(row);
        return;
      }

      var emailInput = el("input", {
        class: "account-input",
        id: "cloud-account-email",
        type: "email",
        inputmode: "email",
        autocomplete: "email",
        autocapitalize: "off",
        spellcheck: "false",
        maxlength: "254",
        value: local.email,
        placeholder: "name@example.com",
        "aria-label": "邮箱"
      });
      emailInput.addEventListener("input", function () {
        local.email = emailInput.value;
      });
      var passwordInput = el("input", {
        class: "account-input",
        id: "cloud-account-password",
        type: "password",
        autocomplete: "current-password",
        autocapitalize: "off",
        spellcheck: "false",
        maxlength: "1024",
        value: "",
        placeholder: "输入密码（不会保存在网页）",
        "aria-label": "密码"
      });

      var fields = el("div", { class: "filters" });
      fields.appendChild(field("邮箱", emailInput));
      fields.appendChild(field("密码", passwordInput));
      statusHost.appendChild(fields);

      var signInButton = el("button", {
        class: "primary-button",
        type: "button",
        id: "cloud-account-signin",
        text: local.busy && local.busyAction === "signin" ? "正在登录…" : "登录",
        disabled: local.busy
      });
      var signUpButton = el("button", {
        class: "secondary-button",
        type: "button",
        id: "cloud-account-signup",
        text: local.busy && local.busyAction === "signup" ? "正在注册…" : "注册",
        disabled: local.busy
      });
      signInButton.addEventListener("click", function () {
        submit("signin", emailInput, passwordInput);
      });
      signUpButton.addEventListener("click", function () {
        submit("signup", emailInput, passwordInput);
      });
      var actions = el("div", { class: "account-row" }, [
        signInButton,
        signUpButton
      ]);
      statusHost.appendChild(actions);
      statusHost.appendChild(el("p", {
        class: "tiny-note",
        text: "首次使用请先注册；如开启邮箱确认，需要先到邮箱完成确认。登录密码不会保存在网页。" +
          "登录失败只影响云端账户，不影响本机复习。"
      }));
    }

    function setBusy(action) {
      local.busy = action !== "";
      local.busyAction = action;
      draw();
    }

    function applyStatus(raw) {
      var status = sanitizeStatus(raw);
      if (!status) {
        return false;
      }
      lastStatus = status;
      lastStatusAt = Date.now();
      local.error = "";
      local.info = "";
      local.email = status.email || local.email;
      if (root.StudyCloudSync &&
          typeof root.StudyCloudSync.notifyAuthStatus === "function") {
        try {
          root.StudyCloudSync.notifyAuthStatus(status);
        } catch (syncError) {
          // 同步模块异常不能影响账户卡片或登录状态。
        }
      }
      return true;
    }

    function resendRemainingSeconds() {
      var remaining = local.resendAvailableAt - Date.now();
      return remaining > 0 ? Math.ceil(remaining / 1000) : 0;
    }

    function scheduleResendRefresh() {
      if (local.resendTimer || local.resendAvailableAt <= Date.now()) {
        return;
      }
      var schedule = root && typeof root.setTimeout === "function" ? root.setTimeout : null;
      if (!schedule) {
        return;
      }
      var delay = Math.min(local.resendAvailableAt - Date.now() + 100, RESEND_COOLDOWN_MS);
      local.resendTimer = schedule.call(root, function () {
        local.resendTimer = null;
        draw();
      }, delay);
    }

    function verifyEmail(email, otpInput) {
      if (local.busy) {
        return;
      }
      var emailText = String(email || local.email || "").trim();
      var token = String(otpInput && otpInput.value !== undefined
        ? otpInput.value
        : local.otp).replace(/[^0-9]/g, "");
      local.email = emailText;
      local.otp = token;
      local.error = "";
      local.info = "";
      if (!emailText) {
        local.error = "请先填写邮箱。";
        draw();
        return;
      }
      if (!token) {
        local.error = "请输入邮件中的验证码。";
        draw();
        return;
      }
      if (!OTP_PATTERN.test(token)) {
        local.error = "验证码应为 6-10 位数字。";
        draw();
        return;
      }
      setBusy("verify");
      callNative("cloudVerifyOtp", { email: emailText, token: token }).then(function (raw) {
        if (applyStatus(raw)) {
          // 只有服务端返回可用会话才走到这里；不在本地猜测或标记“已确认”。
          local.otp = "";
          setBusy("");
        } else {
          setBusy("");
          local.error = "安装版返回的账户状态格式不正确。";
          draw();
        }
      }, function (error) {
        setBusy("");
        local.error = nativeErrorMessage(error);
        draw();
      });
    }

    function resendConfirmation(email) {
      if (local.busy || resendRemainingSeconds() > 0) {
        return;
      }
      var emailText = String(email || local.email || "").trim();
      local.email = emailText;
      local.error = "";
      local.info = "";
      if (!emailText) {
        local.error = "请先填写邮箱。";
        draw();
        return;
      }
      // 发送前即进入 60 秒冷却，避免连续点击和快速重试。
      local.resendAvailableAt = Date.now() + RESEND_COOLDOWN_MS;
      setBusy("resend");
      callNative("cloudResendSignup", { email: emailText }).then(function (raw) {
        if (applyStatus(raw)) {
          local.info = "确认邮件已重新发送。如果邮件中有验证码，也可以直接输入确认。";
          setBusy("");
        } else {
          setBusy("");
          local.error = "安装版返回的账户状态格式不正确。";
          draw();
        }
      }, function (error) {
        setBusy("");
        local.error = nativeErrorMessage(error);
        draw();
      });
    }

    function submit(action, emailInput, passwordInput) {
      if (local.busy) {
        return;
      }
      var email = emailInput.value.trim();
      var password = passwordInput.value;
      // 先取出凭据，再立即清空密码框；密码不进入模块状态或任何存储。
      passwordInput.value = "";
      local.email = email;
      local.error = "";
      local.info = "";
      if (!email) {
        local.error = "请输入邮箱。";
        draw();
        return;
      }
      if (!password) {
        local.error = "请输入密码。";
        draw();
        return;
      }
      setBusy(action);
      var method = action === "signup" ? "cloudSignUp" : "cloudSignIn";
      callNative(method, { email: email, password: password }).then(function (raw) {
        password = "";
        if (applyStatus(raw)) {
          setBusy("");
        } else {
          setBusy("");
          local.error = "安装版返回的账户状态格式不正确。";
          draw();
        }
      }, function (error) {
        password = "";
        setBusy("");
        local.error = nativeErrorMessage(error);
        draw();
      });
    }

    function signOut() {
      if (local.busy) {
        return;
      }
      setBusy("signout");
      callNative("cloudSignOut", {}).then(function (raw) {
        if (!applyStatus(raw)) {
          lastStatus = {
            configured: true,
            loggedIn: false,
            userId: "",
            email: "",
            needsEmailConfirmation: false,
            error: ""
          };
          lastStatusAt = Date.now();
        }
        local.error = "";
        setBusy("");
      }, function (error) {
        // 原生层即使撤销网络失败也会清除本机会话；这里再读一次真实状态。
        local.error = nativeErrorMessage(error);
        setBusy("");
        loadStatus(true).then(function () {
          draw();
        }, function (statusError) {
          local.error = nativeErrorMessage(statusError);
          if (root.StudyCloudSync &&
              typeof root.StudyCloudSync.notifyAuthFailure === "function") {
            try {
              root.StudyCloudSync.notifyAuthFailure();
            } catch (syncError) {
              // 同步模块异常不能影响账户错误提示。
            }
          }
          draw();
        });
      });
    }

    draw();
    if (!lastStatus || Date.now() - lastStatusAt >= STATUS_FRESH_MS) {
      loadStatus(!lastStatus).then(function () {
        local.error = "";
        draw();
      }, function (error) {
        local.error = nativeErrorMessage(error);
        if (root.StudyCloudSync &&
            typeof root.StudyCloudSync.notifyAuthFailure === "function") {
          try {
            root.StudyCloudSync.notifyAuthFailure();
          } catch (syncError) {
            // 同步模块异常不能影响账户错误提示。
          }
        }
        draw();
      });
    }
    // 同步面板与账户卡片共用同一份 UI；状态节点直接追加在“云端账户”区域，
    // Android 与 Windows 安装版都复用这里，不做平台分支。
    if (root.StudyCloudSync && typeof root.StudyCloudSync.render === "function") {
      try {
        var syncPanel = root.StudyCloudSync.render();
        if (syncPanel) {
          section.appendChild(syncPanel);
        }
      } catch (error) {
        // 同步面板初始化失败不能影响账户卡片和本机学习。
      }
    }
    return section;
  }

  return Object.freeze({
    render: render,
    isNative: isNative,
    sanitizeStatus: sanitizeStatus,
    methods: Object.freeze(Object.keys(METHOD_TIMEOUTS))
  });
});
