import axios from "axios";
import "dotenv/config";

const GEO_COUNTRY_HEADERS = [
  "x-vercel-ip-country",
  "cf-ipcountry",
  "cloudfront-viewer-country",
  "x-country-code",
  "x-appengine-country",
  "fastly-client-country",
  "x-geo-country",
];

const TIMEZONE_COUNTRY_MAP = {
  "Africa/Accra": "GH",
  "Africa/Cairo": "EG",
  "Africa/Casablanca": "MA",
  "Africa/Douala": "CM",
  "Africa/Johannesburg": "ZA",
  "Africa/Kampala": "UG",
  "Africa/Kigali": "RW",
  "Africa/Lagos": "NG",
  "Africa/Nairobi": "KE",
  "Africa/Tunis": "TN",
  "America/Anchorage": "US",
  "America/Chicago": "US",
  "America/Denver": "US",
  "America/Los_Angeles": "US",
  "America/New_York": "US",
  "America/Phoenix": "US",
  "Europe/London": "GB",
};

const PLAN_DURATION_MONTHS = 3;
const USD_PLAN_AMOUNTS = {
  pro: 30,
};
const NGN_PLAN_AMOUNTS = {
  pro: 30000,
};
const NGN_CURRENCY = "NGN";

const AFRICAN_COUNTRY_CURRENCY_MAP = {
  DZ: "DZD",
  AO: "AOA",
  BJ: "XOF",
  BW: "BWP",
  BF: "XOF",
  BI: "BIF",
  CM: "XAF",
  CV: "CVE",
  CF: "XAF",
  TD: "XAF",
  KM: "KMF",
  CD: "CDF",
  CG: "XAF",
  CI: "XOF",
  DJ: "DJF",
  EG: "EGP",
  GQ: "XAF",
  ER: "ERN",
  SZ: "SZL",
  ET: "ETB",
  GA: "XAF",
  GM: "GMD",
  GH: "GHS",
  GN: "GNF",
  GW: "XOF",
  KE: "KES",
  LS: "LSL",
  LR: "LRD",
  LY: "LYD",
  MG: "MGA",
  MW: "MWK",
  ML: "XOF",
  MR: "MRU",
  MU: "MUR",
  MA: "MAD",
  MZ: "MZN",
  NA: "NAD",
  NE: "XOF",
  NG: "NGN",
  RW: "RWF",
  ST: "STN",
  SN: "XOF",
  SC: "SCR",
  SL: "SLE",
  SO: "SOS",
  ZA: "ZAR",
  SS: "SSP",
  SD: "SDG",
  TZ: "TZS",
  TG: "XOF",
  TN: "TND",
  UG: "UGX",
  ZM: "ZMW",
  ZW: "ZWL",
};

const EXCHANGE_RATE_API_BASE_URL = "https://v6.exchangerate-api.com/v6";
const COUNTRY_LOOKUP_API_BASE_URL = "https://api.country.is";
const FALLBACK_RATE_TTL_MS = 12 * 60 * 60 * 1000;
const IP_COUNTRY_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

let exchangeRateCache = {
  rates: null,
  expiresAt: 0,
};
const ipCountryCache = new Map();

const currencyDisplayNames =
  typeof Intl.DisplayNames === "function"
    ? new Intl.DisplayNames(["en"], { type: "currency" })
    : null;

const getCountryFromLocale = (locale) => {
  if (typeof locale !== "string") {
    return "";
  }

  const normalized = locale.trim();
  const match = normalized.match(/-([A-Z]{2})(?:$|-)/i);
  return match?.[1]?.toUpperCase() || "";
};

const getClientIp = (req) => {
  const candidates = [
    req.header("cf-connecting-ip"),
    req.header("x-real-ip"),
    req.header("x-client-ip"),
    req.header("x-forwarded-for"),
    req.ip,
  ];

  for (const candidate of candidates) {
    if (typeof candidate !== "string" || !candidate.trim()) {
      continue;
    }

    const first = candidate.split(",")[0]?.trim();
    if (!first) {
      continue;
    }

    return first.replace(/^::ffff:/, "");
  }

  return "";
};

const isPrivateOrLocalIp = (ipAddress) => {
  if (!ipAddress) {
    return true;
  }

  const normalized = ipAddress.trim().toLowerCase();
  if (
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "localhost"
  ) {
    return true;
  }

  const ipv4Match = normalized.match(/^(\d{1,3})\.(\d{1,3})\./);
  if (ipv4Match) {
    const firstOctet = Number(ipv4Match[1]);
    const secondOctet = Number(ipv4Match[2]);

    if (firstOctet === 10 || firstOctet === 127 || firstOctet === 192 && secondOctet === 168) {
      return true;
    }

    if (firstOctet === 169 && secondOctet === 254) {
      return true;
    }

    if (firstOctet === 172 && secondOctet >= 16 && secondOctet <= 31) {
      return true;
    }
  }

  return (
    normalized.startsWith("fc") ||
    normalized.startsWith("fd")
  );
};

const lookupCountryByIp = async (ipAddress) => {
  if (!ipAddress || isPrivateOrLocalIp(ipAddress)) {
    return { countryCode: "", source: "" };
  }

  const cached = ipCountryCache.get(ipAddress);
  if (cached && Date.now() < cached.expiresAt) {
    return { countryCode: cached.countryCode, source: "ip_lookup_cache" };
  }

  try {
    const response = await axios.get(
      `${COUNTRY_LOOKUP_API_BASE_URL}/${encodeURIComponent(ipAddress)}`,
      {
        timeout: 3000,
      }
    );

    const countryCode =
      typeof response.data?.country === "string" &&
      response.data.country.trim().length === 2
        ? response.data.country.trim().toUpperCase()
        : "";

    if (countryCode) {
      ipCountryCache.set(ipAddress, {
        countryCode,
        expiresAt: Date.now() + IP_COUNTRY_CACHE_TTL_MS,
      });
    }

    return { countryCode, source: countryCode ? "ip_lookup" : "" };
  } catch (error) {
    console.warn(`IP country lookup failed for ${ipAddress}:`, error.message);
    return { countryCode: "", source: "" };
  }
};

const getCountryFromHints = async (req) => {
  const queryCountry =
    typeof req.query?.country === "string" ? req.query.country.trim() : "";
  if (queryCountry.length === 2) {
    return { countryCode: queryCountry.toUpperCase(), source: "query_country" };
  }

  for (const header of GEO_COUNTRY_HEADERS) {
    const value = req.header(header);
    if (typeof value === "string" && value.trim().length === 2) {
      return {
        countryCode: value.trim().toUpperCase(),
        source: `header:${header}`,
      };
    }
  }

  const ipCountry = await lookupCountryByIp(getClientIp(req));
  if (ipCountry.countryCode) {
    return ipCountry;
  }

  const timezoneHint =
    typeof req.query?.timezone === "string" ? req.query.timezone.trim() : "";
  if (TIMEZONE_COUNTRY_MAP[timezoneHint]) {
    return {
      countryCode: TIMEZONE_COUNTRY_MAP[timezoneHint],
      source: "timezone_hint",
    };
  }

  const countryHint =
    typeof req.query?.countryHint === "string" ? req.query.countryHint.trim() : "";
  if (countryHint.length === 2) {
    return { countryCode: countryHint.toUpperCase(), source: "query_country_hint" };
  }

  const localeHint =
    typeof req.query?.locale === "string" ? req.query.locale.trim() : "";
  const localeCountry = getCountryFromLocale(localeHint);
  if (localeCountry) {
    return { countryCode: localeCountry, source: "locale_hint" };
  }

  return { countryCode: "US", source: "fallback_us" };
};

const getCurrencyLabel = (currencyCode) => {
  try {
    return currencyDisplayNames?.of(currencyCode) || currencyCode;
  } catch {
    return currencyCode;
  }
};

const formatAmount = (currency, amount) =>
  new Intl.NumberFormat("en", {
    style: "currency",
    currency,
    minimumFractionDigits: amount % 1 === 0 ? 0 : 2,
    maximumFractionDigits: amount % 1 === 0 ? 0 : 2,
  }).format(amount);

const getExchangeRateApiKey = () => process.env.EXCHANGE_RATE_API_KEY || "";

const fetchUsdRates = async () => {
  if (exchangeRateCache.rates && Date.now() < exchangeRateCache.expiresAt) {
    return exchangeRateCache.rates;
  }

  const apiKey = getExchangeRateApiKey();
  if (!apiKey) {
    throw new Error("EXCHANGE_RATE_API_KEY is not configured.");
  }

  const response = await axios.get(
    `${EXCHANGE_RATE_API_BASE_URL}/${apiKey}/latest/USD`,
    {
      timeout: 5000,
    }
  );

  if (response.data?.result !== "success" || !response.data?.conversion_rates) {
    throw new Error("ExchangeRate API returned an invalid response.");
  }

  exchangeRateCache = {
    rates: response.data.conversion_rates,
    expiresAt: response.data.time_next_update_unix
      ? response.data.time_next_update_unix * 1000
      : Date.now() + FALLBACK_RATE_TTL_MS,
  };

  return exchangeRateCache.rates;
};

const convertUsdToCurrency = async (usdAmount, currency) => {
  if (currency === "USD") {
    return usdAmount;
  }

  const rates = await fetchUsdRates();
  const rate = rates?.[currency];

  if (typeof rate !== "number") {
    throw new Error(`No exchange rate available for ${currency}.`);
  }

  return Math.max(1, Math.round(usdAmount * rate));
};

const getDisplayCurrencyForCountry = (countryCode) => {
  if (countryCode === "NG") {
    return NGN_CURRENCY;
  }

  if (AFRICAN_COUNTRY_CURRENCY_MAP[countryCode]) {
    return AFRICAN_COUNTRY_CURRENCY_MAP[countryCode];
  }

  return "USD";
};

const buildDisplayPlans = async (displayCurrency) => {
  if (displayCurrency === NGN_CURRENCY) {
    return {
      free: { amount: 0, currency: NGN_CURRENCY, formatted: formatAmount(NGN_CURRENCY, 0) },
      pro: {
        amount: NGN_PLAN_AMOUNTS.pro,
        currency: NGN_CURRENCY,
        formatted: formatAmount(NGN_CURRENCY, NGN_PLAN_AMOUNTS.pro),
      },
    };
  }

  const proAmount = await convertUsdToCurrency(USD_PLAN_AMOUNTS.pro, displayCurrency);

  return {
    free: { amount: 0, currency: displayCurrency, formatted: formatAmount(displayCurrency, 0) },
    pro: {
      amount: proAmount,
      currency: displayCurrency,
      formatted: formatAmount(displayCurrency, proAmount),
    },
  };
};

const buildCheckoutPlans = async (countryCode) => {
  if (countryCode === "NG") {
    return {
      free: { amount: 0, currency: NGN_CURRENCY, durationMonths: PLAN_DURATION_MONTHS },
      pro: {
        amount: NGN_PLAN_AMOUNTS.pro,
        currency: NGN_CURRENCY,
        durationMonths: PLAN_DURATION_MONTHS,
      },
    };
  }

  const proAmount = await convertUsdToCurrency(USD_PLAN_AMOUNTS.pro, NGN_CURRENCY);

  return {
    free: { amount: 0, currency: NGN_CURRENCY, durationMonths: PLAN_DURATION_MONTHS },
    pro: {
      amount: proAmount,
      currency: NGN_CURRENCY,
      durationMonths: PLAN_DURATION_MONTHS,
    },
  };
};

export const resolvePricingContext = async (req) => {
  const { countryCode, source } = await getCountryFromHints(req);
  const displayCurrency = getDisplayCurrencyForCountry(countryCode);
  const displayPlans = await buildDisplayPlans(displayCurrency);

  const paymentHint =
    countryCode === "NG"
      ? "Charged in NGN via Paystack."
      : `Displayed in ${getCurrencyLabel(
          displayCurrency
        )}, charged in NGN via Paystack at checkout.`;

  return {
    countryCode,
    displayCurrency,
    displayCurrencyLabel: getCurrencyLabel(displayCurrency),
    checkoutCurrency: NGN_CURRENCY,
    paymentHint,
    debug: {
      detectionSource: source,
      ipAddress: getClientIp(req) || null,
      timezoneHint:
        typeof req.query?.timezone === "string" ? req.query.timezone.trim() : null,
      localeHint:
        typeof req.query?.locale === "string" ? req.query.locale.trim() : null,
      countryHint:
        typeof req.query?.countryHint === "string" ? req.query.countryHint.trim() : null,
    },
    plans: displayPlans,
  };
};

export const buildPricingPayload = async (context) => ({
  countryCode: context.countryCode,
  displayCurrency: context.displayCurrency,
  displayCurrencyLabel: context.displayCurrencyLabel,
  checkoutCurrency: context.checkoutCurrency,
  paymentHint: context.paymentHint,
  debug: context.debug,
  plans: context.plans,
});

export const getCheckoutPlanDetails = async (req, plan) => {
  const { countryCode } = await getCountryFromHints(req);
  const checkoutPlans = await buildCheckoutPlans(countryCode);

  if (plan === "free") {
    return checkoutPlans.free;
  }

  return checkoutPlans[plan] || null;
};
