import { useContext, useEffect, useState } from 'react';
import { DangerousToggle } from '../Approvals/DangerousToggle';
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
  installCommands,
  isPowerShellLanguage,
  rawRefFor,
  readRawToken,
  removeRawToken,
  renderTemplate,
  resolveBaseUrl,
  REMOTE_EXECUTE_WARNING,
  sha256Hex,
  writeRawToken
} from '../../utils';
import { Badge, Button, Card } from '../UI';
import copy from 'clipboard-copy';
import { SnippetPin } from './SnippetPin';
import { SnippetHistory } from './SnippetHistory';
import { SnippetFavorite } from './SnippetFavorite';
import { ResolvedVariable } from './SnippetVariables';
import { RunHistory } from '../Runs/RunHistory';
import { SnippetRunModal } from './SnippetRunModal';
import { SnippetAiModal } from './SnippetAiModal';

interface Props {
  snippet: Snippet;
  variables: ResolvedVariable[];
  inputs: Record<string, string>;
}

export const SnippetDetails = (props: Props): JSX.Element => {
  const {
    title,
    language,
    tags,
    createdAt,
    updatedAt,
    description,
    id,
    isPinned,
    rawSlug,
    rawTokenConfigured,
    rawTokenPrefix,
    collection,
    fileName,
    isPublic,
    dangerous,
    usage,
    personal
  } = props.snippet;
  const { variables, inputs } = props;
  const [showRawModal, setShowRawModal] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [showRunModal, setShowRunModal] = useState(false);
  const [showRuns, setShowRuns] = useState(false);
  const [rawToken, setRawToken] = useState(readRawToken(id));
  const [tokenNotice, setTokenNotice] = useState('');
  const [aiMode, setAiMode] = useState<'explain' | 'convert' | null>(null);
  const [checksum, setChecksum] = useState('');
  const [copyNotice, setCopyNotice] = useState('');

  const history = useHistory();
  const { user, snippetRun, snippetAssist, publicBaseUrl } = useContext(AuthContext);
  const canEdit = canEditSnippets(user?.role);

  const {
    deleteSnippet,
    duplicateSnippet,
    setSnippet,
    updateSnippet,
    copySnippetCode,
    patchSnippetFlags,
    renderSnippet,
    sites,
    selectedSiteId,
    setSelectedSiteId
  } = useContext(SnippetsContext);
  const site = sites.find(item => item.id === selectedSiteId) || null;
  // Server runs need a supported language; device runs need a site with devices
  const canRun =
    canEdit &&
    ((snippetRun.enabled && snippetRun.languages.includes(language.toLowerCase())) || Boolean(site));

  // Raw links with a token or key get site, team, and secret values from the
  // server, so only pin what the server cannot know: typed and personal values.
  const tokenVariables: Record<string, string> = {};
  // Public links get nothing from the server, so pin every non-secret value.
  const publicVariables: Record<string, string> = {};

  variables.forEach(variable => {
    if (variable.source === 'missing' || variable.isSecret) {
      return;
    }

    if (variable.source === 'input' || variable.source === 'personal') {
      tokenVariables[variable.name] = variable.value;
    }

    if (variable.value !== variable.defaultValue) {
      publicVariables[variable.name] = variable.value;
    }
  });

  const personalSecrets = variables.filter(
    variable => variable.isSecret && variable.source === 'personal'
  );
  const publicSecrets = variables.filter(variable => variable.isSecret);
  const query = (values: Record<string, string>) => new URLSearchParams(values).toString();

  const creationDate = dateParser(createdAt);
  const updateDate = dateParser(updatedAt);
  const baseUrl = resolveBaseUrl(publicBaseUrl);
  const rawRef = rawRefFor({ id, rawSlug });
  const getRawUrl = (token = rawToken || 'YOUR_SNIPPET_RAW_TOKEN'): string => {
    const params = query({
      key: token,
      ...(site ? { site: site.slug } : {}),
      ...tokenVariables
    });

    return `${buildRawUrl(baseUrl, rawRef)}?${params}`;
  };
  const appUrl = `${baseUrl}/snippet/${id}`;
  const publicUrl = buildShareUrl(baseUrl, rawRef);
  const publicQuery = query(publicVariables);
  const publicRawUrl = `${buildRawUrl(baseUrl, rawRef)}${publicQuery ? `?${publicQuery}` : ''}`;
  const isPowerShell = isPowerShellLanguage(language);
  const powerShellCommand = buildPowerShellRemoteCommand(publicRawUrl);
  // Prefer the token (it carries site values and secrets); fall back to the
  // public link for public snippets without a token in this browser
  const installUsesToken = Boolean(rawToken) || !isPublic;
  const installUrl = installUsesToken ? getRawUrl() : publicRawUrl;
  const installFile = fileName || rawSlug || `snippet-${id}`;
  const installLines = installCommands(language, installUrl, installFile, checksum);
  const missingVariables = variables.filter(variable => variable.source === 'missing');
  const lastUsed = usage?.lastUsedAt ? dateParser(usage.lastUsedAt).relative : 'Never';
  const checksumKey = JSON.stringify([installUsesToken, site?.id, tokenVariables, publicVariables]);

  // Hash exactly what the install URL returns
  useEffect(() => {
    if (!showRawModal) {
      return;
    }

    let cancelled = false;
    setChecksum('');

    const hash = installUsesToken
      ? renderSnippet(id, { siteId: site?.id, variables: tokenVariables }).then(r => r.sha256)
      : sha256Hex(renderTemplate(props.snippet.code, publicVariables));

    hash
      .then(value => {
        if (!cancelled) {
          setChecksum(value);
        }
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [showRawModal, checksumKey, props.snippet.code]);

  const copyCode = async () => {
    setCopyNotice('');

    try {
      await copySnippetCode(props.snippet, { siteId: site?.id, variables: inputs });
      setCopyNotice(site ? `Copied for ${site.name}` : 'Copied');
    } catch {
      setCopyNotice('Could not copy this snippet.');
    }
  };

  const togglePublic = () => {
    if (!canEdit) {
      return;
    }

    const nextPublic = !isPublic;

    if (
      nextPublic &&
      !window.confirm(
        'Anyone with the public link will be able to view this snippet and fetch /raw without a token. Secret values are never filled into public links.'
      )
    ) {
      return;
    }

    patchSnippetFlags(id, { isPublic: nextPublic });
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
        <span className='snippet-title-actions'>
          <SnippetFavorite id={id} isFavorite={Boolean(personal?.isFavorite)} />
          <SnippetPin id={id} isPinned={isPinned} />
        </span>
      </h5>
      <p className='snippet-description'>{description}</p>

      {sites.length > 0 && (
        <label className='snippet-site-picker'>
          <span>Site</span>
          <select
            className='form-control form-control-sm'
            value={site?.id || ''}
            onChange={e => setSelectedSiteId(Number(e.target.value) || null)}
          >
            <option value=''>No site (team values)</option>
            {sites.map(item => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
      )}

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
        <DangerousToggle endpoint={`/api/snippets/${id}/dangerous`} value={Boolean(dangerous)} />
      </div>

      <div className='metric-row'>
        <span>Created</span>
        <span>{creationDate.relative}</span>
      </div>

      <div className='metric-row'>
        <span>Last updated</span>
        <span>{updateDate.relative}</span>
      </div>

      <div className='metric-row'>
        <span>Last used</span>
        <span>{lastUsed}</span>
      </div>

      <div className='metric-row'>
        <span>Usage</span>
        <span className='snippet-usage'>
          {usage?.views || 0} views · {usage?.copies || 0} copies ·{' '}
          {usage?.rawFetches || 0} raw · {usage?.runs || 0} runs
        </span>
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
            text={site ? `Run… (${site.name})` : 'Run…'}
            color='secondary'
            small
            outline
            handler={() => setShowRunModal(true)}
          />
        )}

        {snippetAssist.enabled && (
          <div className='ai-buttons'>
            <Button text='Explain' color='secondary' small outline handler={() => setAiMode('explain')} />
            {canEdit && (
              <Button text='Convert…' color='secondary' small outline handler={() => setAiMode('convert')} />
            )}
          </div>
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
          text='Run history'
          color='secondary'
          small
          outline
          handler={() => setShowRuns(true)}
        />

        <Button
          text='Copy code'
          color='secondary'
          small
          handler={copyCode}
        />
        {copyNotice && <p className='form-text mb-0 text-center'>{copyNotice}</p>}
      </div>

      {showRuns && (
        <div className='raw-modal-backdrop' role='dialog' aria-modal='true'>
          <div className='raw-modal'>
            <div className='raw-modal-header'>
              <div>
                <p className='eyebrow'>Run history</p>
                <h3>{title}</h3>
              </div>
              <button type='button' onClick={() => setShowRuns(false)}>
                Close
              </button>
            </div>
            <RunHistory query={{ snippetId: id }} showSnippet={false} />
          </div>
        </div>
      )}

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

            <p className='eyebrow raw-modal-section'>Install</p>
            {site && installUsesToken && (
              <p className='form-text'>
                Using <strong>{site.name}</strong> values (<code>site={site.slug}</code>).
              </p>
            )}
            {!installUsesToken && publicSecrets.length > 0 && (
              <p className='raw-token-notice'>
                Public links never include secrets ({publicSecrets.map(v => v.name).join(', ')}).
                Generate a token to fill them in.
              </p>
            )}
            {installUsesToken && personalSecrets.length > 0 && (
              <p className='raw-token-notice'>
                Your personal secrets ({personalSecrets.map(v => v.name).join(', ')}) are not
                sent in raw links. Team or site values are used instead.
              </p>
            )}
            {missingVariables.length > 0 && (
              <p className='raw-token-notice'>
                Fill in {missingVariables.map(v => v.name).join(', ')} first. Empty
                placeholders are sent as-is.
              </p>
            )}
            {!isPublic && !rawToken && (
              <p className='form-text'>
                Generate a token below, or swap in the admin raw API key, before
                running these.
              </p>
            )}
            {installLines.map(line => (
              <div className='raw-modal-row' key={line.label}>
                <span>{line.label}</span>
                <code>{line.command}</code>
                <button type='button' onClick={() => copy(line.command)}>
                  Copy
                </button>
              </div>
            ))}
            <div className='raw-modal-row'>
              <span>SHA-256</span>
              <code>{checksum || 'Calculating…'}</code>
              <button
                type='button'
                onClick={() => copy(checksum)}
                disabled={!checksum}
              >
                Copy
              </button>
            </div>
            <p className='form-text'>
              The checksum covers exactly what the install URL returns. The
              server also sends it as the <code>X-Content-SHA256</code> header.
            </p>

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
        <SnippetRunModal
          snippet={props.snippet}
          site={site}
          inputs={inputs}
          resolved={variables}
          onClose={() => {
            setShowRunModal(false);
            setSnippet(id);
          }}
        />
      )}

      {aiMode && (
        <SnippetAiModal
          snippet={props.snippet}
          mode={aiMode}
          canEdit={canEdit}
          onClose={() => setAiMode(null)}
        />
      )}
    </Card>
  );
};
