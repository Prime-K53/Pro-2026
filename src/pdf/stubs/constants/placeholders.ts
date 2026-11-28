export const PLACEHOLDERS = { LOGO: '', SIGNATURE: '' };

/**
 * Placeholder helper object.
 *
 * Consumers call `getPlaceholder.address()` / `.phone()`, so the contract is an
 * object of helpers rather than a single lookup function. The web build has no
 * company assets, so every helper resolves to an empty string.
 */
export const getPlaceholder = {
  address: (): string => '',
  phone: (): string => '',
  email: (): string => '',
  website: (): string => '',
  logo: (): string => '',
  signature: (): string => '',
};
