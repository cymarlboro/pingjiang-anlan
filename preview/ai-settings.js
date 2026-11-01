/*
 * 平江安澜 · AI 解析设置
 *
 * 浏览器预览：只把非敏感设置写入 localStorage；API Key 仅存在当前页面
 * 内存变量中，不写 localStorage、不进入 StudyApp state、不导出、不写日志，
 * 也不出现在错误消息里。预览不发起真实网络请求。
 *
 * 安装版：settings 由 getApiConfig 读取（不含密钥），保存走 saveApiConfig；
 * Key 输入框只把值交给安装版安全存储，保存完成后立即清空，不进入网页变量、
 * state、localStorage 或导出。
 */
(function (global) {
  "use strict";

  const STORAGE_KEY = "pingjianganlan.preview.ai-settings.v1";
  const DEEPSEEK_BASE_URL = "https://api.deepseek.com/v1";
  const SERVICE_TYPES = ["compatible", "deepseek"];
  const DEFAULT_SAFE_SETTINGS = Object.freeze({
    serviceType: "compatible",
    serviceName: "自定义兼容接口",
    baseUrl: "",
    model: "",
    maxQuestions: 5
  });

  const nativeApp = global.NativeApp;
  const nativeEnabled = Boolean(nativeApp && nativeApp.hasBridge);
  let nativeConfig = null;
  let nativeConfigLoading = false;
  let nativeConfigLoaded = false;
  let nativeKeyPresent = false;
  let nativeBusy = false;
  let nativeConfigWaiters = [];
  let aiSettingsOpen = false;

  // 网页预览的密钥唯一存放位置。安装版分支不使用此变量。
  let runtimeKey = "";

  function isPlainObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }

  function clampQuestions(value, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number)) {
      return fallback;
    }
    return Math.min(10, Math.max(1, Math.round(number)));
  }

  function normalizeSafeSettings(raw) {
    const value = isPlainObject(raw) ? raw : {};
    const serviceType = SERVICE_TYPES.includes(value.serviceType)
      ? value.serviceType
      : DEFAULT_SAFE_SETTINGS.serviceType;
    const serviceName = typeof value.serviceName === "string"
      ? value.serviceName.trim().slice(0, 40)
      : "";
    const model = typeof value.model === "string" ? value.model.trim().slice(0, 120) : "";
    const baseCheck = validateBaseUrl(value.baseUrl);
    return {
      serviceType: serviceType,
      serviceName: serviceName || (serviceType === "deepseek" ? "DeepSeek" : DEFAULT_SAFE_SETTINGS.serviceName),
      baseUrl: baseCheck.ok ? baseCheck.value : "",
      model: model,
      maxQuestions: clampQuestions(value.maxQuestions, DEFAULT_SAFE_SETTINGS.maxQuestions)
    };
  }

  function loadSafeSettings() {
    try {
      const raw = global.localStorage.getItem(STORAGE_KEY);
      if (!raw) {
        return Object.assign({}, DEFAULT_SAFE_SETTINGS);
      }
      return normalizeSafeSettings(JSON.parse(raw));
    } catch (error) {
      return Object.assign({}, DEFAULT_SAFE_SETTINGS);
    }
  }

  let safeSettings = loadSafeSettings();

  function persistSafeSettings(next) {
    try {
      global.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * 校验 Base URL：
   * - 只允许 HTTPS；
   * - 仅 localhost / 127.0.0.1 可用 HTTP（本地自定义服务）；
   * - 拒绝用户名/密码、query、hash、javascript 等协议；
   * - 去掉末尾斜线，并剥离误粘贴的 /chat/completions 后缀，只保存 base。
   */
  function validateBaseUrl(raw) {
    const input = typeof raw === "string" ? raw.trim() : "";
    function rejected(error) {
      return { ok: false, valid: false, value: "", normalized: "", error: error };
    }
    if (!input) {
      return rejected("请填写 Base URL。");
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(input) === false) {
      return rejected("Base URL 需以 https:// 开头；本地服务可用 http://localhost 或 http://127.0.0.1。");
    }
    if (/(?:^|\s)(?:javascript|data|vbscript|file):/i.test(input)) {
      return rejected("只支持 HTTPS；本地 localhost 可用 HTTP。");
    }
    if (input.includes("?") || input.includes("#")) {
      return rejected("Base URL 不能包含查询参数（?）或片段（#）。");
    }
    let parsed;
    try {
      parsed = new URL(input);
    } catch (error) {
      return rejected("Base URL 格式不正确。");
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return rejected("只支持 HTTPS；本地 localhost 可用 HTTP。");
    }
    if (parsed.username || parsed.password) {
      return rejected("Base URL 不能包含用户名或密码。");
    }
    if (parsed.protocol === "http:") {
      const host = parsed.hostname.toLowerCase();
      if (host !== "localhost" && host !== "127.0.0.1") {
        return rejected("HTTP 仅允许 localhost 或 127.0.0.1；其他服务请使用 HTTPS。");
      }
    }
    let pathname = parsed.pathname || "";
    pathname = pathname.replace(/\/+$/, "");
    pathname = pathname.replace(/\/chat\/completions$/i, "");
    pathname = pathname.replace(/\/+$/, "");
    const value = parsed.origin + pathname;
    if (!value || value === "null") {
      return rejected("Base URL 格式不正确。");
    }
    return { ok: true, valid: true, value: value, normalized: value, error: "" };
  }

  function getSafeSettings() {
    return Object.assign({}, safeSettings);
  }

  function hasRuntimeKey() {
    return runtimeKey.length > 0;
  }

  function clearRuntimeKey() {
    runtimeKey = "";
  }

  function nativeErrorMessage(error) {
    if (!error) {
      return "操作未完成，请稍后重试。";
    }
    const message = String(error.message || error || "").trim();
    return message || "操作未完成，请稍后重试。";
  }

  function getNativeConfig() {
    if (!nativeConfig) {
      return null;
    }
    return {
      serviceName: nativeConfig.serviceName,
      baseUrl: nativeConfig.baseUrl,
      model: nativeConfig.model,
      maxQuestions: nativeConfig.maxQuestions,
      hasKey: nativeKeyPresent
    };
  }

  function normalizeNativeConfig(raw) {
    const value = isPlainObject(raw) ? raw : {};
    const baseCheck = validateBaseUrl(value.baseUrl);
    return {
      serviceName: typeof value.serviceName === "string"
        ? value.serviceName.trim().slice(0, 40)
        : "",
      baseUrl: baseCheck.ok ? baseCheck.value : (typeof value.baseUrl === "string" ? value.baseUrl.trim() : ""),
      model: typeof value.model === "string" ? value.model.trim().slice(0, 120) : "",
      maxQuestions: clampQuestions(value.maxQuestions, DEFAULT_SAFE_SETTINGS.maxQuestions),
      hasKey: Boolean(value.hasKey)
    };
  }

  function flushNativeConfigWaiters(kind, value) {
    const waiters = nativeConfigWaiters.slice();
    nativeConfigWaiters = [];
    waiters.forEach(function (callbacks) {
      if (!callbacks) {
        return;
      }
      if (kind === "load" && typeof callbacks.onLoad === "function") {
        callbacks.onLoad(value);
      } else if (kind === "error" && typeof callbacks.onError === "function") {
        callbacks.onError(value);
      }
    });
  }

  function loadNativeConfig(callbacks) {
    if (!nativeEnabled) {
      return Promise.resolve(null);
    }
    if (nativeConfigLoaded && nativeConfig) {
      return Promise.resolve(getNativeConfig());
    }
    if (nativeConfigLoading) {
      // 页面重绘可能发生在读取途中；保留新表单的回调，读到后更新它。
      if (callbacks) {
        nativeConfigWaiters.push(callbacks);
      }
      return Promise.resolve(null);
    }
    nativeConfigLoading = true;
    if (callbacks && typeof callbacks.onStart === "function") {
      callbacks.onStart();
    }
    return nativeApp.call("getApiConfig", {}, { timeoutMs: 8000 }).then(function (result) {
      const config = normalizeNativeConfig(result);
      nativeConfig = config;
      nativeKeyPresent = config.hasKey;
      nativeConfigLoaded = true;
      nativeConfigLoading = false;
      if (callbacks && typeof callbacks.onLoad === "function") {
        callbacks.onLoad(getNativeConfig());
      }
      flushNativeConfigWaiters("load", getNativeConfig());
      return getNativeConfig();
    }).catch(function (error) {
      nativeConfigLoading = false;
      const message = nativeErrorMessage(error);
      if (callbacks && typeof callbacks.onError === "function") {
        callbacks.onError(message);
      }
      flushNativeConfigWaiters("error", message);
      return null;
    });
  }

  function el(tag, attributes, children) {
    const node = global.document.createElement(tag);
    if (attributes) {
      Object.keys(attributes).forEach(function (key) {
        const value = attributes[key];
        if (value === null || value === undefined || value === false) {
          return;
        }
        if (key === "class") {
          node.className = String(value);
        } else if (key === "text") {
          node.textContent = String(value);
        } else if (key === "value") {
          node.value = value;
        } else if (key === "checked" || key === "disabled" || key === "hidden" || key === "open") {
          node[key] = Boolean(value);
        } else if (key === "selected") {
          node.selected = Boolean(value);
        } else {
          node.setAttribute(key, value === true ? "" : String(value));
        }
      });
    }
    (Array.isArray(children) ? children : (children === undefined ? [] : [children])).forEach(function (child) {
      if (child === null || child === undefined || child === false) {
        return;
      }
      if (typeof child === "string" || typeof child === "number") {
        node.appendChild(global.document.createTextNode(String(child)));
      } else {
        node.appendChild(child);
      }
    });
    return node;
  }

  function render() {
    if (!global.document) {
      return null;
    }
    const isNative = nativeEnabled;
    const details = el("details", { class: "ai-settings", id: "ai-settings", open: aiSettingsOpen });
    details.addEventListener("toggle", function () {
      aiSettingsOpen = Boolean(details.open);
    });
    const summary = el("summary", { class: "ai-settings-summary" }, [
      el("span", { class: "ai-settings-title", text: "AI 解析设置" }),
      el("span", {
        class: "ai-settings-badge",
        text: isNative ? "联网解析" : "仅安卓安装版可连接"
      })
    ]);
    details.appendChild(summary);

    const body = el("div", { class: "ai-settings-body" });
    body.appendChild(el("p", {
      class: "section-copy",
      text: isNative
        ? "选择兼容接口，填写服务地址、模型和自己的密钥。复习与题库保持离线；只有生成问答时需要联网。"
        : "在这里选择兼容接口并由你自己填写模型名称。网页预览只保存非敏感设置，不调用真实接口，不显示假连接成功。"
    }));
    body.appendChild(el("p", {
      class: "ai-settings-secret-note",
      text: isNative
        ? "密钥由安装版安全保存，保存后不会再显示，也不会进入网页存储、学习记录或导出。"
        : "网页预览：密钥刷新后清除。密钥仅保存在当前页面内存，不写入 localStorage、导出、日志或错误消息。"
    }));

    const serviceSelect = el("select", {
      class: "select-input",
      id: "ai-service-type",
      "aria-label": "服务类型"
    }, [
      el("option", {
        value: "compatible",
        text: "兼容接口（自定义）",
        selected: safeSettings.serviceType === "compatible"
      }),
      el("option", {
        value: "deepseek",
        text: "DeepSeek（预设 Base URL）",
        selected: safeSettings.serviceType === "deepseek"
      })
    ]);
    const serviceNameInput = el("input", {
      class: "text-input",
      id: "ai-service-name",
      type: "text",
      maxlength: "40",
      autocomplete: "off",
      value: isNative ? (nativeConfig ? nativeConfig.serviceName : "") : safeSettings.serviceName,
      "aria-label": "服务名称"
    });
    const baseInput = el("input", {
      class: "text-input",
      id: "ai-base-url",
      type: "url",
      inputmode: "url",
      autocomplete: "off",
      spellcheck: "false",
      value: isNative ? (nativeConfig ? nativeConfig.baseUrl : "") : safeSettings.baseUrl,
      placeholder: "https://api.example.com/v1",
      "aria-label": "Base URL"
    });
    const modelInput = el("input", {
      class: "text-input",
      id: "ai-model",
      type: "text",
      maxlength: "120",
      autocomplete: "off",
      value: isNative ? (nativeConfig ? nativeConfig.model : "") : safeSettings.model,
      placeholder: "手动填写服务商提供的模型名称",
      "aria-label": "模型名称，由用户手动填写"
    });
    const maxInput = el("input", {
      class: "number-input",
      id: "ai-max-questions",
      type: "number",
      inputmode: "numeric",
      min: "1",
      max: "10",
      step: "1",
      value: isNative
        ? String(nativeConfig ? nativeConfig.maxQuestions : DEFAULT_SAFE_SETTINGS.maxQuestions)
        : String(safeSettings.maxQuestions),
      "aria-label": "默认每段最多生成题数，1 到 10"
    });
    const apiKeyInput = el("input", {
      class: "text-input",
      id: "ai-api-key",
      type: "password",
      autocomplete: "off",
      spellcheck: "false",
      value: "",
      placeholder: isNative
        ? (nativeKeyPresent
          ? "已保存密钥；留空保留，输入新密钥可替换"
          : "输入服务商提供的 API Key")
        : (hasRuntimeKey() ? "当前内存中已有密钥，输入可替换" : "仅保存在当前页面内存"),
      "aria-label": "API Key"
    });

    const fieldError = el("p", {
      class: "ai-field-error",
      id: "ai-base-url-error",
      role: "alert",
      hidden: true
    });
    function clearFieldError() {
      fieldError.textContent = "";
      fieldError.hidden = true;
      baseInput.removeAttribute("aria-invalid");
    }
    function showFieldError(message) {
      fieldError.textContent = message;
      fieldError.hidden = false;
      baseInput.setAttribute("aria-invalid", "true");
      baseInput.focus();
    }

    const keyStatus = el("span", {
      class: "setting-sub",
      id: "ai-key-status",
      text: isNative
        ? (nativeKeyPresent ? "已保存密钥（不会显示）" : "尚未保存密钥")
        : (hasRuntimeKey() ? "当前内存中已有密钥（未保存）" : "当前没有内存密钥")
    });
    function updateKeyStatus() {
      if (isNative) {
        keyStatus.textContent = nativeKeyPresent
          ? "已保存密钥（不会显示）"
          : "尚未保存密钥";
      } else {
        keyStatus.textContent = hasRuntimeKey()
          ? "当前输入框有密钥（仅内存，未保存）"
          : "当前没有内存密钥";
      }
    }

    let nativeDirty = false;
    [serviceNameInput, baseInput, modelInput, maxInput].forEach(function (field) {
      field.addEventListener("input", function () {
        nativeDirty = true;
      });
    });
    if (!isNative) {
      apiKeyInput.addEventListener("input", function () {
        runtimeKey = String(apiKeyInput.value || "");
        updateKeyStatus();
        setStatus(hasRuntimeKey()
          ? "API Key 已在当前页面内存中；尚未保存，刷新页面即清除。"
          : "API Key 已从当前页面内存中清除；网页从不持久化密钥。",
        "info");
      });
    } else {
      apiKeyInput.addEventListener("input", function () {
        // 安装版不把输入值复制到任何变量；保存时直接读取输入框一次。
        updateKeyStatus();
        if (apiKeyInput.value) {
          setStatus("新密钥尚未保存；点击“保存设置”后交给安装版安全保存，输入框会清空。", "info");
        }
      });
    }

    const presetButton = el("button", {
      class: "secondary-button ai-preset-button",
      type: "button",
      text: "填入 DeepSeek 预设 Base URL"
    });
    presetButton.addEventListener("click", function () {
      if (isNative) {
        serviceSelect.value = "deepseek";
      } else {
        serviceSelect.value = "deepseek";
      }
      baseInput.value = DEEPSEEK_BASE_URL;
      if (!serviceNameInput.value.trim()) {
        serviceNameInput.value = "DeepSeek";
      }
      nativeDirty = true;
      clearFieldError();
      setStatus("已填入 DeepSeek 预设 Base URL。模型名称仍需你手动填写；不会假设固定模型清单。", "info");
    });

    serviceSelect.addEventListener("change", function () {
      if (serviceSelect.value === "deepseek" && !baseInput.value.trim()) {
        baseInput.value = DEEPSEEK_BASE_URL;
        if (!serviceNameInput.value.trim()) {
          serviceNameInput.value = "DeepSeek";
        }
      }
      nativeDirty = true;
      clearFieldError();
    });

    body.appendChild(el("div", { class: "ai-field" }, [
      el("label", { class: "field-label", for: "ai-service-name", text: "服务名称" }),
      serviceNameInput,
      el("span", {
        class: "setting-sub",
        text: "用于在生成前确认发送目标的服务名称。"
      })
    ]));
    if (!isNative) {
      body.appendChild(el("div", { class: "ai-field" }, [
        el("label", { class: "field-label", for: "ai-service-type", text: "服务类型" }),
        serviceSelect,
        el("span", {
          class: "setting-sub",
          text: "默认兼容接口（自定义）；DeepSeek 仅预设 Base URL，不内置固定模型 ID。"
        })
      ]));
    }
    body.appendChild(el("div", { class: "ai-field" }, [
      el("label", { class: "field-label", for: "ai-base-url", text: "Base URL" }),
      baseInput,
      el("span", {
        class: "setting-sub",
        text: "默认使用 HTTPS；HTTP 仅允许 localhost 或 127.0.0.1 作为本地服务。保存时只保留 base。"
      }),
      fieldError,
      presetButton
    ]));
    body.appendChild(el("div", { class: "ai-field" }, [
      el("label", { class: "field-label", for: "ai-model", text: "模型名称（手动填写）" }),
      modelInput,
      el("span", {
        class: "setting-sub",
        text: "不内置固定模型 ID，也不假设模型清单固定；请填写所选服务实际提供的模型名称。"
      })
    ]));
    body.appendChild(el("div", { class: "ai-field" }, [
      el("label", { class: "field-label", for: "ai-api-key", text: "API Key" }),
      apiKeyInput,
      keyStatus
    ]));
    body.appendChild(el("div", { class: "ai-field" }, [
      el("label", { class: "field-label", for: "ai-max-questions", text: "默认每段最多生成" }),
      el("div", { class: "number-field" }, [
        maxInput,
        el("span", { class: "number-suffix", text: "题（1—10）" })
      ])
    ]));

    const status = el("p", {
      class: "ai-status",
      id: "ai-status",
      role: "status",
      "aria-live": "polite"
    });
    function setStatus(message, tone) {
      status.textContent = message;
      status.className = "ai-status" + (tone === "error" ? " is-error" : tone === "info" ? " is-info" : "");
    }

    const modelsHost = el("div", { class: "ai-models", id: "ai-models", hidden: true });
    function showModels(models) {
      modelsHost.replaceChildren();
      if (!models.length) {
        modelsHost.hidden = true;
        return;
      }
      modelsHost.hidden = false;
      modelsHost.appendChild(el("p", {
        class: "ai-models-title",
        text: "服务返回的模型（点选可填入模型名称）"
      }));
      const list = el("div", { class: "ai-model-list" });
      models.forEach(function (name) {
        const button = el("button", {
          class: "ai-model-chip",
          type: "button",
          text: name,
          "aria-label": "填入模型名称：" + name
        });
        button.addEventListener("click", function () {
          modelInput.value = name;
          nativeDirty = true;
          setStatus("已填入服务返回的模型名称；保存设置后生效。", "info");
        });
        list.appendChild(button);
      });
      modelsHost.appendChild(list);
    }

    const saveButton = el("button", {
      class: "primary-button",
      type: "button",
      id: "ai-save",
      text: isNative ? "保存设置" : "保存非敏感设置"
    });
    const clearKeyButton = el("button", {
      class: "secondary-button",
      type: "button",
      id: "ai-clear-key",
      text: isNative ? "清除已保存密钥" : "清除内存密钥"
    });
    const testButton = el("button", {
      class: "secondary-button",
      type: "button",
      id: "ai-test-connection",
      disabled: !isNative,
      "aria-label": isNative ? "测试连接并读取服务模型列表" : "连接测试需安卓安装版，网页预览不可用",
      text: isNative ? "测试连接" : "连接测试（需安卓安装版）"
    });
    const retryButton = el("button", {
      class: "secondary-button",
      type: "button",
      id: "ai-retry-config",
      text: "重新读取设置",
      hidden: true
    });

    function setBusy(busy) {
      nativeBusy = busy;
      saveButton.disabled = busy || (isNative && !nativeConfigLoaded);
      testButton.disabled = busy || !isNative || (isNative && (!nativeConfigLoaded || !nativeKeyPresent));
      clearKeyButton.disabled = busy || (isNative && !nativeKeyPresent) || (!isNative && !hasRuntimeKey());
      retryButton.disabled = busy;
      saveButton.textContent = busy ? "正在处理…" : (isNative ? "保存设置" : "保存非敏感设置");
    }

    function syncNativeFields(config) {
      if (!config) {
        return;
      }
      if (!nativeDirty) {
        serviceNameInput.value = config.serviceName || "";
        baseInput.value = config.baseUrl || "";
        modelInput.value = config.model || "";
        maxInput.value = String(config.maxQuestions || DEFAULT_SAFE_SETTINGS.maxQuestions);
      }
      nativeKeyPresent = Boolean(config.hasKey);
      updateKeyStatus();
    }

    function reportNativeConfigLoaded(config) {
      nativeConfigLoaded = Boolean(config);
      nativeConfigLoading = false;
      mergeNativeConfigIntoCache(config);
      syncNativeFields(config);
      retryButton.hidden = true;
      setBusy(false);
      setStatus(config && config.baseUrl
        ? "已读取已保存的设置。密钥状态：" + (nativeKeyPresent ? "已保存（不显示）" : "未保存")
        : "尚未保存接口设置。填写服务地址、模型和密钥后保存。",
      "info");
    }

    function mergeNativeConfigIntoCache(config) {
      if (!config) {
        return;
      }
      nativeConfig = {
        serviceName: config.serviceName || "",
        baseUrl: config.baseUrl || "",
        model: config.model || "",
        maxQuestions: clampQuestions(config.maxQuestions, DEFAULT_SAFE_SETTINGS.maxQuestions)
      };
      nativeKeyPresent = Boolean(config.hasKey);
    }

    function loadNativeIntoForm() {
      if (!isNative) {
        return;
      }
      if (nativeConfigLoaded && nativeConfig) {
        syncNativeFields(getNativeConfig());
        retryButton.hidden = true;
        setBusy(false);
        setStatus(nativeKeyPresent
          ? "已读取已保存的设置；密钥已保存但不会显示。"
          : "已读取已保存的设置；尚未保存密钥。",
        "info");
        return;
      }
      setBusy(true);
      retryButton.hidden = true;
      setStatus("正在读取已保存的设置…", "info");
      loadNativeConfig({
        onLoad: reportNativeConfigLoaded,
        onError: function (message) {
          nativeConfigLoaded = false;
          setBusy(false);
          setStatus("暂时无法读取已保存的设置：" + message + " 可点“重新读取设置”。", "error");
          retryButton.hidden = false;
        }
      });
    }

    retryButton.addEventListener("click", function () {
      if (nativeBusy) {
        return;
      }
      nativeConfigLoaded = false;
      nativeConfig = null;
      loadNativeIntoForm();
    });

    saveButton.addEventListener("click", function () {
      if (nativeBusy) {
        return;
      }
      const baseCheck = validateBaseUrl(baseInput.value);
      if (!baseCheck.ok) {
        showFieldError(baseCheck.error);
        return;
      }
      clearFieldError();
      const name = serviceNameInput.value.trim().slice(0, 40) ||
        (isNative ? "自定义兼容接口" : (serviceSelect.value === "deepseek" ? "DeepSeek" : DEFAULT_SAFE_SETTINGS.serviceName));
      const model = modelInput.value.trim().slice(0, 120);
      const maxQuestions = clampQuestions(maxInput.value, DEFAULT_SAFE_SETTINGS.maxQuestions);
      maxInput.value = String(maxQuestions);

      if (!isNative) {
        safeSettings = {
          serviceType: SERVICE_TYPES.includes(serviceSelect.value) ? serviceSelect.value : "compatible",
          serviceName: name,
          baseUrl: baseCheck.value,
          model: model,
          maxQuestions: maxQuestions
        };
        baseInput.value = safeSettings.baseUrl;
        const saved = persistSafeSettings(safeSettings);
        setStatus(saved
          ? "已保存非敏感设置（服务、Base URL、模型、题量）。API Key 未保存，刷新后清除；网页不会调用真实接口。"
          : "浏览器阻止了本机存储；非敏感设置仅当前页面有效。API Key 仍未保存，刷新后清除。",
        saved ? "info" : "error");
        setBusy(false);
        return;
      }

      const payload = {
        serviceName: name,
        baseUrl: baseCheck.value,
        model: model,
        maxQuestions: maxQuestions
      };
      // 只在用户本次输入了内容时传递密钥。空值表示保留已保存密钥。
      const keyFromInput = String(apiKeyInput.value || "");
      if (keyFromInput) {
        payload.apiKey = keyFromInput;
      }
      setBusy(true);
      setStatus(keyFromInput ? "正在保存设置和新密钥…" : "正在保存设置；密钥保持不变…", "info");
      nativeApp.call("saveApiConfig", payload, { timeoutMs: 20000 }).then(function (result) {
        const config = normalizeNativeConfig(result);
        nativeConfigLoaded = true;
        mergeNativeConfigIntoCache(config);
        // 保存成功后立即清空输入框，密钥不再留在网页中。
        apiKeyInput.value = "";
        baseInput.value = config.baseUrl || baseCheck.value;
        updateKeyStatus();
        setBusy(false);
        setStatus(nativeKeyPresent
          ? "设置已保存；密钥已交给安装版安全保存，网页不再保留。"
          : "设置已保存；当前没有保存密钥。",
        "info");
        if (global.dispatchEvent && typeof global.CustomEvent === "function") {
          global.dispatchEvent(new global.CustomEvent("study-ai-config-changed", {
            detail: getNativeConfig()
          }));
        }
      }).catch(function (error) {
        // 失败时不清空输入框，方便用户重试；密钥从未写入网页存储。
        setBusy(false);
        setStatus("保存未完成：" + nativeErrorMessage(error) + " 输入框中的密钥不会被保存或导出。", "error");
      });
    });

    clearKeyButton.addEventListener("click", function () {
      if (nativeBusy) {
        return;
      }
      if (isNative) {
        const baseCheck = validateBaseUrl(baseInput.value);
        if (!baseCheck.ok) {
          showFieldError(baseCheck.error);
          return;
        }
        const payload = {
          serviceName: serviceNameInput.value.trim().slice(0, 40) || "自定义兼容接口",
          baseUrl: baseCheck.value,
          model: modelInput.value.trim().slice(0, 120),
          maxQuestions: clampQuestions(maxInput.value, DEFAULT_SAFE_SETTINGS.maxQuestions),
          clearKey: true
        };
        setBusy(true);
        setStatus("正在清除已保存的密钥…", "info");
        nativeApp.call("saveApiConfig", payload, { timeoutMs: 15000 }).then(function (result) {
          const config = normalizeNativeConfig(result);
          nativeConfigLoaded = true;
          mergeNativeConfigIntoCache(config);
          apiKeyInput.value = "";
          updateKeyStatus();
          setBusy(false);
          setStatus("已清除安装版保存的密钥。非敏感设置保持不变；留空保存不会再恢复旧密钥。", "info");
          if (global.dispatchEvent && typeof global.CustomEvent === "function") {
            global.dispatchEvent(new global.CustomEvent("study-ai-config-changed", {
              detail: getNativeConfig()
            }));
          }
        }).catch(function (error) {
          setBusy(false);
          setStatus("密钥未清除：" + nativeErrorMessage(error), "error");
        });
        return;
      }
      runtimeKey = "";
      apiKeyInput.value = "";
      updateKeyStatus();
      setStatus("内存密钥已清除；刷新页面也会清除。此操作不影响已保存的非敏感设置。", "info");
      setBusy(false);
    });

    testButton.addEventListener("click", function () {
      if (!isNative || nativeBusy) {
        return;
      }
      setBusy(true);
      modelsHost.hidden = true;
      setStatus("正在连接服务并读取模型列表…", "info");
      nativeApp.call("testApi", {}, { timeoutMs: 60000 }).then(function (result) {
        const models = Array.isArray(result && result.models)
          ? result.models.map(function (name) {
            return typeof name === "string" ? name.trim().slice(0, 160) : "";
          }).filter(Boolean).slice(0, 100)
          : [];
        const configuredModel = typeof result.configuredModel === "string"
          ? result.configuredModel.trim().slice(0, 120)
          : (nativeConfig && nativeConfig.model ? nativeConfig.model : modelInput.value.trim());
        const modelListed = Boolean(result && result.modelListed === true);
        const scopeNote = result && result.connectionScope === "model-list-only"
          ? "列表只证明 /models 可读，不代表已通过生成请求，也不代表模型可用于生成；本次没有发起付费生成。"
          : "列表只来自 /models，不代表已通过生成请求。";
        setBusy(false);
        if (models.length) {
          showModels(models);
          if (configuredModel && !modelListed) {
            setStatus("连接成功，但已配置模型 “" + configuredModel +
              "” 不在服务返回的模型列表中。不会自动替换；请从下方服务返回的模型列表点选，或手动修改并保存。" +
              scopeNote, "error");
          } else if (configuredModel && modelListed) {
            setStatus("连接成功：已配置模型 “" + configuredModel +
              "” 出现在服务返回的模型列表中；这只表示列表命中，仍不代表生成一定可用。下方列表可点击填入。" +
              scopeNote, "info");
          } else {
            setStatus("连接成功；服务实际返回 " + models.length +
              " 个模型。请从下方可点击的列表选择或手动填写，不会自动替换已填内容。" + scopeNote, "info");
          }
        } else {
          showModels([]);
          setStatus("连接成功，但服务没有返回模型列表。无法判断 “" +
            (configuredModel || "当前模型") +
            "” 是否存在；请手动填写模型名称，不会自动替换，也不会伪造模型清单。", "info");
        }
      }).catch(function (error) {
        setBusy(false);
        showModels([]);
        setStatus("连接测试未成功：" + nativeErrorMessage(error) +
          " 如果该服务不提供模型列表，可继续手动填写模型名称并保存设置。", "error");
      });
    });

    body.appendChild(el("div", { class: "ai-actions" }, [
      saveButton,
      retryButton
    ]));
    body.appendChild(el("div", { class: "ai-actions" }, [
      testButton,
      clearKeyButton
    ]));
    body.appendChild(modelsHost);
    body.appendChild(status);
    body.appendChild(el("p", {
      class: "tiny-note",
      text: isNative
        ? "生成问答前会再次展示服务、地址域名、模型、文件和所选原文范围，由你确认后才发送。"
        : "连接测试在网页预览中禁用：这里不调用真实 API，也不会假装测试成功。"
    }));

    const privacy = el("details", { class: "ai-android-details" });
    privacy.appendChild(el("summary", {
      text: isNative ? "发送范围与隐私" : "发送范围与网页预览说明"
    }));
    privacy.appendChild(el("p", {
      class: "ai-settings-secret-note",
      text: isNative
        ? "API 密钥由安装版安全保存，网页无法读回。服务地址默认 HTTPS；HTTP 仅用于 localhost 本地服务。"
        : "网页预览不接入真实接口，也不保存密钥。安装版负责网络请求、超时和错误处理。"
    }));
    privacy.appendChild(el("ol", { class: "ai-flow-list" }, [
      el("li", { text: "生成前先确认来源文件、原文页段、字数和发送目标。" }),
      el("li", { text: "只发送你勾选的小段原文，不上传整库或无关文件。" }),
      el("li", { text: "原文只作为内容处理，不当作指令；返回结果先进入草稿。" }),
      el("li", { text: "草稿默认选中，但只有你明确确认后才加入题库。" }),
      el("li", { text: "模型名称由你填写；服务不提供模型列表时不猜测、不伪造。" })
    ]));
    body.appendChild(privacy);

    details.appendChild(body);
    setBusy(false);
    if (isNative) {
      loadNativeIntoForm();
    }
    return details;
  }

  global.StudyAISettings = Object.freeze({
    render: render,
    validateBaseUrl: validateBaseUrl,
    getSafeSettings: getSafeSettings,
    getNativeConfig: getNativeConfig,
    ensureNativeConfig: function () { return loadNativeConfig(); },
    hasRuntimeKey: hasRuntimeKey,
    clearRuntimeKey: clearRuntimeKey,
    storageKey: STORAGE_KEY,
    deepSeekBaseUrl: DEEPSEEK_BASE_URL
  });
})(typeof window !== "undefined" ? window : globalThis);
