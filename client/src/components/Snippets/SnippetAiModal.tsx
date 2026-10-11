import { useContext, useEffect, useState } from 'react';
import axios from 'axios';
import copy from 'clipboard-copy';
import { SnippetsContext } from '../../store';
import { Response, Snippet } from '../../typescript/interfaces';
import { apiError } from '../Variables/VariableFields';
import { SnippetCode } from './SnippetCode';

interface Explanation {
  provider: string;
  summary: string;
  steps: string[];
  requirements: string[];
  risks: string[];
}

interface Conversion {
  provider: string;
  language: string;
  code: string;
  notes: string[];
}

const TARGETS = ['powershell', 'bash', 'python', 'javascript', 'go', 'bat'];

interface Props {
  snippet: Snippet;
  mode: 'explain' | 'convert';
  canEdit: boolean;
  onClose: () => void;
}

export const SnippetAiModal = (props: Props): JSX.Element => {
  const { snippet, mode, canEdit, onClose } = props;
  const { createSnippet } = useContext(SnippetsContext);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [explanation, setExplanation] = useState<Explanation | null>(null);
  const [conversion, setConversion] = useState<Conversion | null>(null);
  const [language, setLanguage] = useState(
    TARGETS.find(target => target !== snippet.language.toLowerCase()) || 'powershell'
  );

  const explain = async () => {
    setLoading(true);
    setError('');

    try {
      const res = await axios.post<Response<Explanation>>(`/api/snippets/${snippet.id}/explain`, {});
      setExplanation(res.data.data);
    } catch (err) {
      setError(apiError(err, 'The assistant could not explain this snippet.'));
    } finally {
      setLoading(false);
    }
  };

  const convert = async () => {
    setLoading(true);
    setError('');
    setConversion(null);

    try {
      const res = await axios.post<Response<Conversion>>(`/api/snippets/${snippet.id}/convert`, { language });
      setConversion(res.data.data);
    } catch (err) {
      setError(apiError(err, 'The assistant could not convert this snippet.'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (mode === 'explain') {
      explain();
    }
  }, []);

  const saveCopy = () => {
    if (!conversion) {
      return;
    }

    createSnippet({
      title: `${snippet.title} (${conversion.language})`,
      description: snippet.description,
      language: conversion.language,
      code: conversion.code,
      docs: [
        `Converted from [${snippet.title}](/snippet/${snippet.id}) by the AI assistant. Review before running.`,
        ...conversion.notes.map(note => `- ${note}`)
      ].join('\n\n'),
      isPinned: false,
      tags: (snippet.tags || []).filter(tag => tag !== snippet.language.toLowerCase()),
      collection: snippet.collection,
      isPublic: false
    });
  };

  const list = (title: string, items: string[], ordered = false) =>
    items.length > 0 && (
      <>
        <p className='eyebrow mt-3 mb-1'>{title}</p>
        {ordered ? (
          <ol className='ai-list'>{items.map((item, index) => <li key={index}>{item}</li>)}</ol>
        ) : (
          <ul className='ai-list'>{items.map((item, index) => <li key={index}>{item}</li>)}</ul>
        )}
      </>
    );

  return (
    <div className='raw-modal-backdrop' role='dialog' aria-modal='true'>
      <div className='raw-modal'>
        <div className='raw-modal-header'>
          <div>
            <p className='eyebrow'>{mode === 'explain' ? 'Explain' : 'Convert'}</p>
            <h3>{snippet.title}</h3>
          </div>
          <button type='button' onClick={onClose}>
            Close
          </button>
        </div>

        {mode === 'convert' && (
          <div className='run-target'>
            <label>
              <span>Convert to</span>
              <select className='form-control' value={language} onChange={e => setLanguage(e.target.value)}>
                {TARGETS.filter(target => target !== snippet.language.toLowerCase()).map(target => (
                  <option key={target} value={target}>
                    {target}
                  </option>
                ))}
              </select>
            </label>
            <button type='button' className='btn btn-primary' onClick={convert} disabled={loading}>
              {loading ? 'Converting…' : 'Convert'}
            </button>
          </div>
        )}

        {loading && mode === 'explain' && <p className='text-muted'>Asking the assistant…</p>}
        {error && <div className='alert alert-danger'>{error}</div>}

        {explanation && (
          <div className='ai-explanation'>
            <p>{explanation.summary}</p>
            {list('What it does', explanation.steps, true)}
            {list('Needs', explanation.requirements)}
            {explanation.risks.length > 0 ? (
              <div className='ai-risks'>{list('Watch out for', explanation.risks)}</div>
            ) : (
              <p className='form-text'>No risky actions spotted.</p>
            )}
            <p className='form-text mt-3 mb-0'>Written by {explanation.provider === 'openai' ? 'Codex' : 'Claude'}. Check before relying on it.</p>
          </div>
        )}

        {conversion && (
          <>
            <SnippetCode code={conversion.code} language={conversion.language} />
            {list('Check these', conversion.notes)}
            <div className='variable-editor-actions mt-2'>
              <button type='button' className='btn btn-sm btn-outline-secondary' onClick={() => copy(conversion.code)}>
                Copy
              </button>
              {canEdit && (
                <button type='button' className='btn btn-sm btn-primary' onClick={saveCopy}>
                  Save as new snippet
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
};
