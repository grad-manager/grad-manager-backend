export const TRIAL_DAYS = 3;

export const buildTrial = (now = new Date()) => {
    const startDate = now.toISOString();
    const endDate = new Date(now.getTime() + TRIAL_DAYS * 24 * 60 * 60 * 1000).toISOString();
    return { startDate, endDate };
};

const isValidDate = (value) => {
    const date = new Date(value);
    return !Number.isNaN(date.getTime());
};

export const isTrialActive = (trial, now = new Date()) => {
    if (!trial?.startDate || !trial?.endDate) return false;
    if (!isValidDate(trial.startDate) || !isValidDate(trial.endDate)) return false;
    return now.getTime() <= new Date(trial.endDate).getTime();
};

const normalizePlan = (plan, defaultPlan = 'free') => {
    const value = String(plan || defaultPlan).trim().toLowerCase();
    if (value === 'premium') return 'pro';
    if (value === 'pro') return 'pro';
    return 'free';
};

export const getEffectivePlan = (userData, { defaultPlan = 'free', trialPlan = 'pro', excludeTrial = false } = {}) => {
    const basePlan = normalizePlan(userData?.subscription?.plan, defaultPlan);
    if (excludeTrial) return basePlan;
    return isTrialActive(userData?.trial) ? normalizePlan(trialPlan, defaultPlan) : basePlan;
};

