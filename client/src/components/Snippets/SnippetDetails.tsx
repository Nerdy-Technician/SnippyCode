import { useContext, useState } from 'react';
import { useHistory } from 'react-router-dom';
import axios from 'axios';
import { SnippetsContext } from '../../store';
import { Response, Snippet, SnippetVersion } from '../../typescript/interfaces';
import { dateParser } from '../../utils';
import { Badge, Button, Card } from '../UI';
import copy from 'clipboard-copy';
import { SnippetPin } from './SnippetPin';

interface Props {
  snippet: Snippet;
}

export const SnippetDetails = (props: Props): JSX.Element => {
  const {
    title,
    language,
    tags,
    createdAt,
    updatedAt,
    description,
    code,
    id,
    isPinned,
    rawSlug,
    rawTokenConfigured,
    rawTokenPrefix,
    collection,
    fileName
  } = props.snippet;
  const [showRawModal, setShowRawModal] = useState(false);
  const [rawToken, setRawToken] = useState(
    window.localStorage.getItem(`snippysafe_raw_token_${id}`) || ''
  );
  const [versions, setVersions] = useState<SnippetVersion[]>([]);

  const history = useHistory();

  const { deleteSnippet, setSnippet } = useContext(SnippetsContext);

  const creationDate = dateParser(createdAt);
  const updateDate = dateParser(updatedAt);
  const getRawUrl = (token = rawToken || 'YOUR_SNIPPET_RAW_TOKEN'): string => {
    const { protocol, host } = window.location;
    const rawRef = rawSlug || id;

    return `${protocol}//${host}/raw/${rawRef}?key=${encodeURIComponent(
      token
    )}`;
  };
  const appUrl = `${window.location.protocol}//${window.location.host}/snippet/${id}`;
  const curlCommand = `curl -fsSL "${getRawUrl()}"`;

  const generateRawToken = async () => {
    const res = await axios.post<
      Response<{
        token: string;
        rawSlug: string;
        rawTokenPrefix: string;
        rawTokenConfigured: boolean;
      }>
    >(`/api/snippets/${id}/raw-token`);
    setRawToken(res.data.data.token);
    window.localStorage.setItem(
      `snippysafe_raw_token_${id}`,
      res.data.data.token
    );
    setSnippet(id);
  };

  const revokeRawToken = async () => {
    await axios.delete(`/api/snippets/${id}/raw-token`);
    setRawToken('');
    window.localStorage.removeItem(`snippysafe_raw_token_${id}`);
    setSnippet(id);
  };

  const loadVersions = async () => {
    const res = await axios.get<Response<SnippetVersion[]>>(
      `/api/snippets/${id}/versions`
    );
    setVersions(res.data.data);
  };

  // const copyHandler = () => {
  //   copy(code);
  // };

  return (
    <Card>
      <h5 className='card-title d-flex align-items-center justify-content-between'>
        {title}
        <SnippetPin id={id} isPinned={isPinned} />
      </h5>
      <p className='snippet-description'>{description}</p>

      {/* LANGUAGE */}
      <div className='metric-row'>
        <span>Language</span>
        <span className='fw-bold'>{language}</span>
      </div>

      <div className='metric-row'>
        <span>Collection</span>
        <span className='fw-bold'>{collection || 'General'}</span>
      </div>

      <div className='metric-row'>
        <span>File</span>
        <span className='fw-bold'>{fileName || rawSlug || `snippet-${id}`}</span>
      </div>

      {/* CREATED AT */}
      <div className='metric-row'>
        <span>Created</span>
        <span>{creationDate.relative}</span>
      </div>

      {/* UPDATED AT */}
      <div className='metric-row'>
        <span>Last updated</span>
        <span>{updateDate.relative}</span>
      </div>
      <hr />

      {/* TAGS */}
      <div>
        {tags.map((tag, idx) => (
          <span className='me-2' key={idx}>
            <Badge text={tag} color='light' />
          </span>
        ))}
      </div>
      <hr />

      {/* ACTIONS */}
      <div className='d-grid g-2' style={{ rowGap: '10px' }}>
        <Button
          text='Delete'
          color='danger'
          small
          outline
          handler={() => deleteSnippet(id)}
        />

        <Button
          text='Edit'
          color='secondary'
          small
          outline
          handler={() => {
            setSnippet(id);
            history.push({
              pathname: `/editor/${id}`,
              state: { from: window.location.pathname }
            });
          }}
        />

        <Button
          text='Raw URL'
          color='secondary'
          small
          outline
          handler={() => setShowRawModal(true)}
        />

        <Button
          text='Versions'
          color='secondary'
          small
          outline
          handler={loadVersions}
        />

        <Button
          text='Copy code'
          color='secondary'
          small
          handler={() => copy(code)}
        />
      </div>

      {versions.length > 0 && (
        <div className='snippet-versions'>
          <h6>Version history</h6>
          {versions.map(version => (
            <article key={version.id}>
              <strong>{version.title}</strong>
              <span>{dateParser(version.createdAt).relative}</span>
              <button type='button' onClick={() => copy(version.code)}>
                Copy code
              </button>
            </article>
          ))}
        </div>
      )}

      {showRawModal && (
        <div className='raw-modal-backdrop' role='dialog' aria-modal='true'>
          <div className='raw-modal'>
            <div className='raw-modal-header'>
              <div>
                <p className='eyebrow'>Raw URL</p>
                <h3>{title}</h3>
              </div>
              <button type='button' onClick={() => setShowRawModal(false)}>
                Close
              </button>
            </div>

            <div className='raw-modal-row'>
              <span>App URL</span>
              <code>{appUrl}</code>
              <button type='button' onClick={() => copy(appUrl)}>
                Copy
              </button>
            </div>
            <div className='raw-modal-row'>
              <span>API-key URL</span>
              <code>{getRawUrl()}</code>
              <button type='button' onClick={() => copy(getRawUrl())}>
                Copy
              </button>
            </div>
            <div className='raw-modal-row'>
              <span>curl</span>
              <code>{curlCommand}</code>
              <button type='button' onClick={() => copy(curlCommand)}>
                Copy
              </button>
            </div>

            <div className='profile-meta'>
              <span>Token</span>
              <strong>
                {rawToken
                  ? 'Available in this browser'
                  : rawTokenConfigured
                  ? `${rawTokenPrefix}...`
                  : 'Not generated'}
              </strong>
            </div>

            <div className='admin-actions'>
              <button
                type='button'
                className='btn btn-primary'
                onClick={generateRawToken}
              >
                {rawTokenConfigured ? 'Regenerate token' : 'Generate token'}
              </button>
              <button
                type='button'
                className='btn btn-outline-danger'
                onClick={revokeRawToken}
              >
                Revoke token
              </button>
            </div>
          </div>
        </div>
      )}
    </Card>
  );
};
