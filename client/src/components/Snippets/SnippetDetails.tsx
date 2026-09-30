import { useContext, useState } from 'react';
import { Link, useHistory } from 'react-router-dom';
import axios from 'axios';
import { AuthContext, SnippetsContext } from '../../store';
import { Response, Snippet } from '../../typescript/interfaces';
import {
  buildPowerShellRemoteCommand,
  buildRawUrl,
  buildShareUrl,
  canEditSnippets,
  dateParser,
  isPowerShellLanguage,
  rawRefFor,
  readRawToken,
  removeRawToken,
  resolveBaseUrl,
  REMOTE_EXECUTE_WARNING,
  writeRawToken
} from '../../utils';
import { Badge, Button, Card } from '../UI';
import copy from 'clipboard-copy';
import { SnippetPin } from './SnippetPin';
import { SnippetHistory } from './SnippetHistory';

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
    fileName,
    isPublic
  } = props.snippet;
  const [showRawModal, setShowRawModal] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [showRunModal, setShowRunModal] = useState(false);
  const [rawToken, setRawToken] = useState(readRawToken(id));
  const [tokenNotice, setTokenNotice] = useState('');
  const [runOutput, setRunOutput] = useState<{
    ok: boolean;
    timedOut: boolean;
    exitCode: number | null;
    stdout: string;
    stderr: string;
  } | null>(null);
  const [runError, setRunError] = useState('');
  const [running, setRunning] = useState(false);

  const history = useHistory();
  const { user, snippetRun, publicBaseUrl } = useContext(AuthContext);
  const canEdit = canEditSnippets(user?.role);
  const canRun =
    canEdit &&
    snippetRun.enabled &&
    snippetRun.languages.includes(language.toLowerCase());

  const { deleteSnippet, duplicateSnippet, setSnippet, patchSnippetFlags } =
    useContext(SnippetsContext);

  const creationDate = dateParser(createdAt);
  const updateDate = dateParser(updatedAt);
  const baseUrl = resolveBaseUrl(publicBaseUrl);
  const rawRef = rawRefFor({ id, rawSlug });
  const getRawUrl = (token = rawToken || 'YOUR_SNIPPET_RAW_TOKEN'): string =>
    `${buildRawUrl(baseUrl, rawRef)}?key=${encodeURIComponent(token)}`;
  const appUrl = `${baseUrl}/snippet/${id}`;
  const publicUrl = buildShareUrl(baseUrl, rawRef);
  const curlCommand = `curl -fsSL "${getRawUrl()}"`;
  const publicRawUrl = buildRawUrl(baseUrl, rawRef);
  const isPowerShell = isPowerShellLanguage(language);
  const powerShellCommand = buildPowerShellRemoteCommand(publicRawUrl);

  const togglePublic = () => {
    if (!canEdit) {
      return;
    }

    const nextPublic = !isPublic;

    if (
      nextPublic &&
      !window.confirm(
        'Anyone with the public link will be able to view this snippet and fetch /raw without a token.'
      )
    ) {
      return;
    }

    patchSnippetFlags(id, { isPublic: nextPublic });
  };

  const runOnServer = async () => {
    if (
      !window.confirm(
        `Run this snippet on the SnippyCode server? It will execute ${language} with a ${Math.round(
          snippetRun.timeoutMs / 1000
        )}s timeout.`
      )
    ) {
      return;
    }

    setShowRunModal(true);
    setRunning(true);
    setRunError('');
    setRunOutput(null);

    try {
      const res = await axios.post<
        Response<{
          ok: boolean;
          timedOut: boolean;
          exitCode: number | null;
          stdout: string;
          stderr: string;
        }>
      >(`/api/snippets/${id}/run`);
      setRunOutput(res.data.data);
    } catch (err) {
      setRunError('Could not run this snippet on the server.');
    } finally {
      setRunning(false);
    }
  };

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
    writeRawToken(id, res.data.data.token);
    setTokenNotice(
      'This token is stored only in this browser. Other browsers and previous copies stop working.'
    );
    setSnippet(id);
  };

  const revokeRawToken = async () => {
    await axios.delete(`/api/snippets/${id}/raw-token`);
    setRawToken('');
    removeRawToken(id);
    setTokenNotice('Raw token revoked. Existing curl commands will fail until you generate a new one.');
    setSnippet(id);
  };

  return (
    <Card>
      <h5 className='card-title d-flex align-items-center justify-content-between'>
        {title}
        <SnippetPin id={id} isPinned={isPinned} />
      </h5>
      <p className='snippet-description'>{description}</p>

      <div className='metric-row'>
        <span>Language</span>
        <span className='fw-bold'>{language}</span>
      </div>

      <div className='metric-row'>
        <span>Collection</span>
        <span className='fw-bold'>
          <Link
            to={`/snippets?collection=${encodeURIComponent(collection || 'General')}`}
          >
            {collection || 'General'}
          </Link>
        </span>
      </div>

      <div className='metric-row'>
        <span>File</span>
        <span className='fw-bold'>{fileName || rawSlug || `snippet-${id}`}</span>
      </div>

      <div className='metric-row'>
        <span>Visibility</span>
        <span className='fw-bold'>{isPublic ? 'Public' : 'Private'}</span>
      </div>

      <div className='metric-row'>
        <span>Created</span>
        <span>{creationDate.relative}</span>
      </div>

      <div className='metric-row'>
        <span>Last updated</span>
        <span>{updateDate.relative}</span>
      </div>
      <hr />

      <div>
        {tags.map((tag, idx) => (
          <span className='me-2' key={idx}>
            <Badge text={tag} color='light' />
          </span>
        ))}
      </div>
      <hr />

      <div className='d-grid g-2' style={{ rowGap: '10px' }}>
        {canEdit && (
          <Button
            text='Delete'
            color='danger'
            small
            outline
            handler={() => deleteSnippet(id)}
          />
        )}

        {canEdit && (
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
        )}

        {canEdit && (
          <Button
            text='Duplicate'
            color='secondary'
            small
            outline
            handler={() => duplicateSnippet(id)}
          />
        )}

        {canEdit && (
          <Button
            text={isPublic ? 'Make private' : 'Make public'}
            color='secondary'
            small
            outline
            handler={togglePublic}
          />
        )}

        {isPublic && (
          <Button
            text='Copy public link'
            color='secondary'
            small
            outline
            handler={() => copy(publicUrl)}
          />
        )}

        {canRun && (
          <Button
            text='Run on server'
            color='secondary'
            small
            outline
            handler={runOnServer}
          />
        )}

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
          handler={() => setShowHistory(true)}
        />

        <Button
          text='Copy code'
          color='secondary'
          small
          handler={() => copy(code)}
        />
      </div>

      {showHistory && (
        <SnippetHistory
          snippet={props.snippet}
          onClose={() => setShowHistory(false)}
          onRestored={() => {
            setShowHistory(false);
            setSnippet(id);
          }}
        />
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
            {isPublic && (
              <div className='raw-modal-row'>
                <span>Public page</span>
                <code>{publicUrl}</code>
                <button type='button' onClick={() => copy(publicUrl)}>
                  Copy
                </button>
              </div>
            )}
            {isPublic && (
              <div className='raw-modal-row'>
                <span>Public raw</span>
                <code>{publicRawUrl}</code>
                <button type='button' onClick={() => copy(publicRawUrl)}>
                  Copy
                </button>
              </div>
            )}
            {isPowerShell && isPublic && (
              <>
                <div className='raw-modal-row'>
                  <span>PowerShell remote execute</span>
                  <code>{powerShellCommand}</code>
                  <button type='button' onClick={() => copy(powerShellCommand)}>
                    Copy
                  </button>
                </div>
                <p className='remote-execute-warning' role='note'>
                  {REMOTE_EXECUTE_WARNING}
                </p>
              </>
            )}
            {isPowerShell && !isPublic && (
              <p className='form-text'>
                PowerShell remote execute (<code>irm … | iex</code>) is
                available once this snippet is public.
              </p>
            )}
            <div className='raw-modal-row'>
              <span>Raw URL</span>
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

            {tokenNotice && <p className='raw-token-notice'>{tokenNotice}</p>}

            <p className='form-text mb-3'>
              CI can use this snippet token, or the admin raw API key, as
              <code> ?key=</code> or the <code>x-api-key</code> header.
            </p>

            {canEdit && (
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
            )}
          </div>
        </div>
      )}

      {showRunModal && (
        <div className='raw-modal-backdrop' role='dialog' aria-modal='true'>
          <div className='raw-modal'>
            <div className='raw-modal-header'>
              <div>
                <p className='eyebrow'>Server run</p>
                <h3>{title}</h3>
              </div>
              <button type='button' onClick={() => setShowRunModal(false)}>
                Close
              </button>
            </div>
            {running && <p>Running…</p>}
            {runError && <div className='alert alert-danger'>{runError}</div>}
            {runOutput && (
              <>
                <div className='profile-meta'>
                  <span>Result</span>
                  <strong>
                    {runOutput.timedOut
                      ? 'Timed out'
                      : runOutput.ok
                      ? 'Exit 0'
                      : `Exit ${runOutput.exitCode}`}
                  </strong>
                </div>
                <label className='form-label'>stdout</label>
                <pre className='run-output'>{runOutput.stdout || '(empty)'}</pre>
                <label className='form-label'>stderr</label>
                <pre className='run-output'>{runOutput.stderr || '(empty)'}</pre>
              </>
            )}
          </div>
        </div>
      )}
    </Card>
  );
};
