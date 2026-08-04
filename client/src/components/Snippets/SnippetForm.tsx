import {
  ChangeEvent,
  FormEvent,
  Fragment,
  useState,
  useContext,
  useEffect,
  useRef
} from 'react';
import Editor from '@monaco-editor/react';
import type { OnMount } from '@monaco-editor/react';
import copy from 'clipboard-copy';
import { SnippetsContext, ThemeContext } from '../../store';
import { NewSnippet } from '../../typescript/interfaces';
import { Button, Card } from '../UI';
import languagesData from '../../data/languages.json';

interface Props {
  inEdit?: boolean;
}

interface LanguageOption {
  name: string;
  aliases: string[];
}

const availableLanguages = languagesData.languages as LanguageOption[];
type EditorInstance = Parameters<OnMount>[0];
type DetectedLanguage = {
  language: string;
  confidence: number;
};

const secretPatterns: Array<[RegExp, string]> = [
  [/-----BEGIN (RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----/, 'private key'],
  [/\b(password|passwd|secret|token|api[_-]?key|client_secret)\s*[:=]\s*['"]?[^'"\s]+/i, 'credential assignment'],
  [/github_pat_[A-Za-z0-9_]+|ghp_[A-Za-z0-9_]+|gho_[A-Za-z0-9_]+/i, 'GitHub token'],
  [/AWS_(SECRET_ACCESS_KEY|ACCESS_KEY_ID)\s*=/i, 'AWS credential'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'AWS access key'],
  [/https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]+/i, 'Slack webhook'],
  [/https:\/\/discord(?:app)?\.com\/api\/webhooks\/\d+\/[A-Za-z0-9._-]+/i, 'Discord webhook'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/, 'Google API key'],
  [/\bnpm_[A-Za-z0-9]{36}\b/, 'npm token'],
  [/\b(postgres|postgresql|mysql|mongodb):\/\/[^:\s]+:[^@\s]+@/i, 'database connection string'],
  [/\bAuthorization:\s*Bearer\s+[A-Za-z0-9._~+/-]+=*/i, 'Bearer token header']
];

const detectSecrets = (code: string, docs: string): string[] =>
  secretPatterns
    .filter(([pattern]) => pattern.test(`${code}\n${docs}`))
    .map(([, label]) => label);

const monacoLanguageAliases: { [key: string]: string } = {
  bash: 'shell',
  csharp: 'csharp',
  css: 'css',
  dockerfile: 'dockerfile',
  go: 'go',
  html: 'html',
  java: 'java',
  javascript: 'javascript',
  js: 'javascript',
  json: 'json',
  jsx: 'javascript',
  markdown: 'markdown',
  md: 'markdown',
  php: 'php',
  python: 'python',
  py: 'python',
  ruby: 'ruby',
  rust: 'rust',
  scss: 'scss',
  shell: 'shell',
  sh: 'shell',
  sql: 'sql',
  typescript: 'typescript',
  ts: 'typescript',
  tsx: 'typescript',
  xml: 'xml',
  yaml: 'yaml',
  yml: 'yaml'
};

const getMonacoLanguage = (language: string): string => {
  const normalizedLanguage = language.trim().toLowerCase();

  return monacoLanguageAliases[normalizedLanguage] || normalizedLanguage || 'plaintext';
};

const detectLanguage = (code: string): DetectedLanguage => {
  const sample = code.trim();

  if (!sample) {
    return { language: '', confidence: 0 };
  }

  if (/^#!.*\b(bash|sh|zsh)\b/.test(sample) || /\b(echo|fi|elif|esac)\b/.test(sample)) {
    return { language: 'bash', confidence: 0.86 };
  }

  if (/^\s*FROM\s+\S+/im.test(sample) || /^\s*(RUN|COPY|ENTRYPOINT|CMD)\s+/im.test(sample)) {
    return { language: 'dockerfile', confidence: 0.88 };
  }

  if (/^\s*[{[]/.test(sample)) {
    try {
      JSON.parse(sample);
      return { language: 'json', confidence: 0.96 };
    } catch (err) {
      // Keep trying other signatures.
    }
  }

  if (/<\/?[a-z][\s\S]*>/i.test(sample) && /<\/(html|div|section|script|body)>/i.test(sample)) {
    return { language: 'html', confidence: 0.82 };
  }

  if (/^\s*SELECT\s+[\s\S]+\s+FROM\s+/i.test(sample) || /\b(CREATE|ALTER|INSERT INTO|UPDATE)\b/i.test(sample)) {
    return { language: 'sql', confidence: 0.84 };
  }

  if (/\bdef\s+\w+\s*\(|\bimport\s+[\w.]+|if\s+__name__\s*==\s*['"]__main__['"]/.test(sample)) {
    return { language: 'python', confidence: 0.84 };
  }

  if (/\bpackage\s+main\b|\bfunc\s+\w+\s*\([^)]*\)\s*{/.test(sample)) {
    return { language: 'go', confidence: 0.86 };
  }

  if (/\bfn\s+\w+\s*\(|\blet\s+mut\b|println!\s*\(/.test(sample)) {
    return { language: 'rust', confidence: 0.84 };
  }

  if (/\bpublic\s+(class|static)\b|\bSystem\.out\.println\b/.test(sample)) {
    return { language: 'java', confidence: 0.84 };
  }

  if (/\busing\s+System;|\bnamespace\s+\w+|Console\.WriteLine/.test(sample)) {
    return { language: 'csharp', confidence: 0.84 };
  }

  if (/\b(interface|type)\s+\w+\s*[={]|\b(public|private|readonly)\s+\w+|:\s*(string|number|boolean)\b/.test(sample)) {
    return { language: 'typescript', confidence: 0.78 };
  }

  if (/\b(import|export)\s+.*\bfrom\b|=>|console\.log|function\s+\w+\s*\(/.test(sample)) {
    return { language: 'javascript', confidence: 0.72 };
  }

  if (/\.[\w-]+\s*{[\s\S]*:\s*[^;]+;/.test(sample) || /@(media|keyframes)\b/.test(sample)) {
    return { language: 'css', confidence: 0.76 };
  }

  if (/^#\s+\w+|```|\[[^\]]+\]\([^)]+\)/m.test(sample)) {
    return { language: 'markdown', confidence: 0.72 };
  }

  if (/^\s*[\w-]+:\s*.+$/m.test(sample) && /^\s{2,}[\w-]+:/m.test(sample)) {
    return { language: 'yaml', confidence: 0.7 };
  }

  return { language: '', confidence: 0 };
};

export const SnippetForm = (props: Props): JSX.Element => {
  const { inEdit = false } = props;
  const { createSnippet, currentSnippet, updateSnippet } =
    useContext(SnippetsContext);
  const { theme, themes, setTheme } = useContext(ThemeContext);
  const editorRef = useRef<EditorInstance | null>(null);
  const [languageWasManual, setLanguageWasManual] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [commandQuery, setCommandQuery] = useState('');
  const [detectedLanguage, setDetectedLanguage] = useState<DetectedLanguage>({
    language: '',
    confidence: 0
  });

  const [formData, setFormData] = useState<NewSnippet>({
    title: '',
    description: '',
    language: '',
    code: '',
    docs: '',
    isPinned: false,
    tags: [],
    collection: 'General',
    fileName: ''
  });

  useEffect(() => {
    if (inEdit) {
      if (currentSnippet) {
        setFormData({ ...currentSnippet });
        setLanguageWasManual(Boolean(currentSnippet.language));
        setDetectedLanguage(detectLanguage(currentSnippet.code));
      }
    }
  }, [currentSnippet, inEdit]);

  const inputHandler = (
    e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>
  ) => {
    if (e.target.name === 'language') {
      setLanguageWasManual(e.target.value.trim().length > 0);
    }

    setFormData({
      ...formData,
      [e.target.name]: e.target.value
    });
  };

  const stringToTags = (e: ChangeEvent<HTMLInputElement>) => {
    const tags = e.target.value.split(',');
    setFormData({
      ...formData,
      tags
    });
  };

  const editorHandler = (value?: string) => {
    const nextCode = value || '';
    const nextDetectedLanguage = detectLanguage(nextCode);
    setDetectedLanguage(nextDetectedLanguage);

    setFormData({
      ...formData,
      code: nextCode,
      language:
        !languageWasManual && nextDetectedLanguage.language
          ? nextDetectedLanguage.language
          : formData.language
    });
  };

  const editorMountHandler: OnMount = editor => {
    editorRef.current = editor;
  };

  const formatCodeHandler = () => {
    editorRef.current?.getAction('editor.action.formatDocument')?.run();
  };

  const copyCodeHandler = () => {
    copy(formData.code);
  };

  const clearCodeHandler = () => {
    setFormData({
      ...formData,
      code: ''
    });
    setDetectedLanguage({ language: '', confidence: 0 });
  };

  const useDetectedLanguageHandler = () => {
    if (detectedLanguage.language) {
      setFormData({
        ...formData,
        language: detectedLanguage.language
      });
      setLanguageWasManual(false);
    }
  };

  useEffect(() => {
    const keyHandler = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'p') {
        event.preventDefault();
        setCommandPaletteOpen(open => !open);
      }
    };

    window.addEventListener('keydown', keyHandler);
    return () => window.removeEventListener('keydown', keyHandler);
  }, []);

  const runCommand = (handler: () => void) => {
    handler();
    setCommandPaletteOpen(false);
    setCommandQuery('');
  };

  const cycleTheme = () => {
    const currentIndex = themes.findIndex(option => option.value === theme);
    const nextTheme = themes[(currentIndex + 1) % themes.length];
    setTheme(nextTheme.value);
  };

  const duplicateSnippet = () => {
    createSnippet({
      ...formData,
      title: `${formData.title || 'Untitled snippet'} copy`
    });
  };

  const changeLanguageCommand = () => {
    const nextLanguage = window.prompt('Language', formData.language);

    if (nextLanguage !== null) {
      setFormData({
        ...formData,
        language: nextLanguage
      });
      setLanguageWasManual(true);
    }
  };

  const commands = [
    { label: 'Format document', action: formatCodeHandler },
    { label: 'Copy code', action: copyCodeHandler },
    { label: 'Duplicate snippet', action: duplicateSnippet },
    { label: 'Change language', action: changeLanguageCommand },
    { label: 'Use detected language', action: useDetectedLanguageHandler },
    { label: 'Cycle theme', action: cycleTheme },
    { label: 'Clear editor', action: clearCodeHandler }
  ].filter(command =>
    command.label.toLowerCase().includes(commandQuery.trim().toLowerCase())
  );

  const tagsToString = (): string => {
    return formData.tags.join(',');
  };
  const secretWarnings = detectSecrets(formData.code, formData.docs || '');

  const formHandler = (e: FormEvent) => {
    e.preventDefault();
    const payload = {
      ...formData,
      language: formData.language || 'plaintext'
    };

    if (
      secretWarnings.length > 0 &&
      !window.confirm(
        `Possible secrets detected: ${secretWarnings.join(
          ', '
        )}. Save anyway?`
      )
    ) {
      return;
    }

    if (inEdit) {
      if (currentSnippet) {
        updateSnippet(payload, currentSnippet.id);
      }
    } else {
      createSnippet(payload);
    }
  };

  return (
    <Fragment>
      <form className='editor-workbench col-12' onSubmit={e => formHandler(e)}>
        <div className='row g-3 editor-workbench-grid'>
          <div className='col-12 col-xxl-9 col-xl-8'>
            <Card bodyClasses='p-0'>
              <div className='editor-titlebar'>
                <div>
                  <span className='eyebrow'>Snippet code</span>
                  <h2>{formData.title || 'Untitled snippet'}</h2>
                </div>
                <div className='editor-status'>
                  {detectedLanguage.language && (
                    <button type='button' onClick={useDetectedLanguageHandler}>
                      Detected {detectedLanguage.language}
                    </button>
                  )}
                  <span>{getMonacoLanguage(formData.language)}</span>
                </div>
              </div>
              <div className='editor-toolbar'>
                <Button
                  text='Command palette'
                  color='secondary'
                  small
                  outline
                  handler={() => setCommandPaletteOpen(true)}
                />
                <Button
                  text='Format'
                  color='secondary'
                  small
                  outline
                  handler={formatCodeHandler}
                />
                <Button
                  text='Copy'
                  color='secondary'
                  small
                  outline
                  handler={copyCodeHandler}
                />
                <Button
                  text='Clear'
                  color='danger'
                  small
                  outline
                  handler={clearCodeHandler}
                />
              </div>
              {commandPaletteOpen && (
                <div className='command-palette-backdrop'>
                  <div className='command-palette'>
                    <input
                      className='form-control'
                      autoFocus
                      placeholder='Run command'
                      value={commandQuery}
                      onChange={e => setCommandQuery(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Escape') {
                          setCommandPaletteOpen(false);
                        }

                        if (e.key === 'Enter' && commands[0]) {
                          e.preventDefault();
                          runCommand(commands[0].action);
                        }
                      }}
                    />
                    <div className='command-palette-list'>
                      {commands.map(command => (
                        <button
                          key={command.label}
                          type='button'
                          onClick={() => runCommand(command.action)}
                        >
                          {command.label}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              )}
              <div className='monaco-shell'>
                <Editor
                  height='100%'
                  theme='vs-dark'
                  language={getMonacoLanguage(formData.language)}
                  value={formData.code}
                  onChange={editorHandler}
                  onMount={editorMountHandler}
                  options={{
                    automaticLayout: true,
                    bracketPairColorization: { enabled: true },
                    cursorBlinking: 'smooth',
                    fontFamily: 'JetBrains Mono, Fira Code, Consolas, monospace',
                    fontLigatures: true,
                    fontSize: 14,
                    formatOnPaste: true,
                    formatOnType: true,
                    guides: {
                      bracketPairs: true,
                      indentation: true
                    },
                    minimap: { enabled: true },
                    renderLineHighlight: 'all',
                    scrollBeyondLastLine: false,
                    smoothScrolling: true,
                    tabSize: 2,
                    wordWrap: 'on'
                  }}
                />
              </div>
            </Card>
          </div>

          <div className='col-12 col-xxl-3 col-xl-4'>
            <Card classes='editor-side-panel'>
              <h5 className='card-title mb-3'>Snippet details</h5>

              <div className='mb-3'>
                <label htmlFor='title' className='form-label'>
                  Title
                </label>
                <input
                  type='text'
                  className='form-control'
                  id='title'
                  name='title'
                  value={formData.title}
                  placeholder='Recursively copy all files'
                  required
                  onChange={e => inputHandler(e)}
                />
              </div>

              <div className='mb-3'>
                <label htmlFor='description' className='form-label'>
                  Short description
                </label>
                <input
                  type='text'
                  className='form-control'
                  id='description'
                  name='description'
                  value={formData.description}
                  placeholder='Bash script to copy all files from src to dest'
                  onChange={e => inputHandler(e)}
                />
              </div>

              <div className='mb-3'>
                <label htmlFor='language' className='form-label'>
                  Language
                </label>
                <input
                  type='text'
                  className='form-control'
                  id='language'
                  name='language'
                  list='snippet-languages'
                  value={formData.language}
                  placeholder='Auto-detected from code'
                  onChange={e => inputHandler(e)}
                />
                <datalist id='snippet-languages'>
                  {availableLanguages.map(({ name, aliases }) => (
                    <option key={name} value={aliases[0]}>
                      {name}
                    </option>
                  ))}
                </datalist>
              </div>

              <div className='mb-3'>
                <label htmlFor='fileName' className='form-label'>
                  File name
                </label>
                <input
                  type='text'
                  className='form-control'
                  id='fileName'
                  name='fileName'
                  value={formData.fileName}
                  placeholder='install-docker.sh'
                  onChange={e => inputHandler(e)}
                />
              </div>

              <div className='mb-3'>
                <label htmlFor='collection' className='form-label'>
                  Collection
                </label>
                <input
                  type='text'
                  className='form-control'
                  id='collection'
                  name='collection'
                  value={formData.collection}
                  placeholder='Homelab'
                  onChange={e => inputHandler(e)}
                />
              </div>

              <div className='mb-3'>
                <label htmlFor='tags' className='form-label'>
                  Tags
                </label>
                <input
                  type='text'
                  className='form-control'
                  id='tags'
                  name='tags'
                  value={tagsToString()}
                  placeholder='automation, files, loop'
                  onChange={e => stringToTags(e)}
                />
                <div className='form-text'>
                  Tags should be separated with a comma. Language tag will be
                  added automatically
                </div>
              </div>

              <hr />

              {secretWarnings.length > 0 && (
                <div className='alert alert-warning'>
                  Possible secrets detected: {secretWarnings.join(', ')}
                </div>
              )}

              <h5 className='card-title mb-3'>Documentation</h5>
              <div className='mb-3'>
                <textarea
                  className='form-control docs-editor'
                  id='docs'
                  name='docs'
                  rows={10}
                  value={formData.docs}
                  placeholder='`-r` flag stands for `--recursive`'
                  onChange={e => inputHandler(e)}
                ></textarea>
              </div>

              <div className='d-grid'>
                <Button
                  text={`${inEdit ? 'Update snippet' : 'Create snippet'}`}
                  color='secondary'
                  type='submit'
                />
              </div>
            </Card>
          </div>
        </div>
      </form>
    </Fragment>
  );
};
