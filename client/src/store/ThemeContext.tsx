import { createContext, ReactNode, useEffect, useMemo, useState } from 'react';

export type AppTheme = 'dark' | 'light' | 'midnight';

interface ThemeOption {
  label: string;
  value: AppTheme;
}

interface ThemeContextValue {
  theme: AppTheme;
  themes: ThemeOption[];
  primaryColor: string;
  setTheme: (theme: AppTheme) => void;
  setPrimaryColor: (color: string) => void;
  resetPrimaryColor: () => void;
}

const themeStorageKey = 'snippycode-theme';
const primaryStorageKey = 'snippycode-primary-color';
const legacyThemeStorageKey = 'snippysafe-theme';
const legacyPrimaryStorageKey = 'snippysafe-primary-color';

const readLocalStorage = (key: string, legacyKey: string): string | null => {
  const current = window.localStorage.getItem(key);

  if (current) {
    return current;
  }

  const legacy = window.localStorage.getItem(legacyKey);

  if (legacy) {
    window.localStorage.setItem(key, legacy);
    window.localStorage.removeItem(legacyKey);
    return legacy;
  }

  return null;
};

const themeOptions: ThemeOption[] = [
  { label: 'Moon', value: 'dark' },
  { label: 'Sun', value: 'light' },
  { label: 'Mix', value: 'midnight' }
];

const isAppTheme = (value: string | null): value is AppTheme => {
  return themeOptions.some(option => option.value === value);
};

export const ThemeContext = createContext<ThemeContextValue>({
  theme: 'dark',
  themes: themeOptions,
  primaryColor: '#66d9c2',
  setTheme: () => {},
  setPrimaryColor: () => {},
  resetPrimaryColor: () => {}
});

interface Props {
  children: ReactNode;
}

export const ThemeContextProvider = (props: Props): JSX.Element => {
  const [theme, setThemeState] = useState<AppTheme>(() => {
    const storedTheme = readLocalStorage(themeStorageKey, legacyThemeStorageKey);
    return isAppTheme(storedTheme) ? storedTheme : 'dark';
  });
  const [primaryColor, setPrimaryColorState] = useState(() => {
    return readLocalStorage(primaryStorageKey, legacyPrimaryStorageKey) || '#66d9c2';
  });

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem(themeStorageKey, theme);
  }, [theme]);

  useEffect(() => {
    document.documentElement.style.setProperty('--sb-accent', primaryColor);
    document.documentElement.style.setProperty(
      '--sb-accent-hover',
      adjustHexColor(primaryColor, 18)
    );
    document.documentElement.style.setProperty(
      '--sb-accent-contrast',
      getContrastColor(primaryColor)
    );
    document.documentElement.style.setProperty(
      '--sb-active-soft',
      hexToRgba(primaryColor, 0.1)
    );
    document.documentElement.style.setProperty(
      '--sb-active-border',
      hexToRgba(primaryColor, 0.28)
    );
    window.localStorage.setItem(primaryStorageKey, primaryColor);
  }, [primaryColor]);

  const setPrimaryColor = (color: string) => {
    if (/^#[0-9a-f]{6}$/i.test(color)) {
      setPrimaryColorState(color);
    }
  };

  const resetPrimaryColor = () => {
    setPrimaryColorState('#66d9c2');
  };

  const value = useMemo(
    () => ({
      theme,
      themes: themeOptions,
      primaryColor,
      setTheme: setThemeState,
      setPrimaryColor,
      resetPrimaryColor
    }),
    [theme, primaryColor]
  );

  return (
    <ThemeContext.Provider value={value}>{props.children}</ThemeContext.Provider>
  );
};

const adjustHexColor = (hex: string, amount: number): string => {
  const value = hex.replace('#', '');
  const channels = [0, 2, 4].map(index => {
    const channel = parseInt(value.slice(index, index + 2), 16);
    return Math.max(0, Math.min(255, channel + amount));
  });

  return `#${channels
    .map(channel => channel.toString(16).padStart(2, '0'))
    .join('')}`;
};

const hexToRgba = (hex: string, alpha: number): string => {
  const value = hex.replace('#', '');
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
};

const getContrastColor = (hex: string): string => {
  const value = hex.replace('#', '');
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  const brightness = (r * 299 + g * 587 + b * 114) / 1000;
  return brightness > 145 ? '#151a1d' : '#ffffff';
};
