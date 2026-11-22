const directions = new Set(['up', 'down', 'left', 'right']);
const unsafeCharacters = /[\p{Cc}\p{Cs}\u2028-\u202e\u2066-\u2069]/u;

export function exactObject(value, required, optional = []) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
}

export function validText(value, minLength, maxLength) {
  if (typeof value !== 'string' || unsafeCharacters.test(value)) return false;
  const length = [...value].length;
  return length >= minLength && length <= maxLength;
}

export function parseNickname(value) {
  if (typeof value !== 'string' || unsafeCharacters.test(value)) return null;
  const trimmed = value.trim();
  return validText(trimmed, 1, 24) ? trimmed : null;
}

function numberInRange(value, min, max) {
  return Number.isFinite(value) && value >= min && value <= max;
}

function validJourney(journey) {
  return exactObject(journey, ['v', 'x', 'y', 'd', 'n', 'r', 's', 'mu', 'sf', 'z', 'run', 't']) &&
    journey.v === 1 && directions.has(journey.d) &&
    numberInRange(journey.x, 0, 62) && numberInRange(journey.y, 0, 68) &&
    numberInRange(journey.z, 1, 2.6) && Number.isSafeInteger(journey.t) && journey.t >= 0 &&
    ['n', 'r', 's', 'mu', 'sf', 'run'].every((key) => journey[key] === 0 || journey[key] === 1);
}

function validOutfit(outfit) {
  const keys = ['grade', 'hair', 'hairC', 'skin'];
  return exactObject(outfit, keys, ['name', 'glass']) && keys.every((key) => validText(outfit[key], 0, 40)) &&
    (!Object.hasOwn(outfit, 'name') || validText(outfit.name, 0, 40)) &&
    (!Object.hasOwn(outfit, 'glass') || typeof outfit.glass === 'boolean');
}

function validBooleans(value, keys) {
  return exactObject(value, keys) && keys.every((key) => typeof value[key] === 'boolean');
}

const educationLimits = { stage: 12, school: 56, schoolId: 65, year: 4, grade: 18, group: 24 };

function validProfile(profile) {
  return exactObject(profile, [], ['age', 'education']) &&
    (!Object.hasOwn(profile, 'age') || typeof profile.age === 'string' && /^(?:[1-9]|[1-9]\d|1[01]\d|120)?$/.test(profile.age)) &&
    (!Object.hasOwn(profile, 'education') || Array.isArray(profile.education) && profile.education.length <= 64 &&
      profile.education.every((entry) => exactObject(entry, Object.keys(educationLimits)) &&
        Object.entries(educationLimits).every(([key, max]) => validText(entry[key], 0, max))));
}

const validators = {
  journey: validJourney,
  outfit: validOutfit,
  toy: (toy) => validBooleans(toy, ['plane', 'badge', 'worn', 'hints']) &&
    (!toy.badge || toy.plane) && (!toy.worn || toy.badge),
  presence: (presence) => validBooleans(presence, ['findable']),
  profile: validProfile,
};

export function validProgress(progress) {
  return exactObject(progress, [], Object.keys(validators)) &&
    Object.entries(progress).every(([key, value]) => validators[key](value));
}
