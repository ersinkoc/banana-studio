import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

// Real AuthBoundary and authService; only the Supabase client, the media cache and
// the login screen are fixtures. A minimal hook renderer, as in youtube-channel-ref.test.mjs.
const react = `const R=()=>globalThis.__renderer;export const useState=v=>R().useState(v),useRef=v=>R().useRef(v),useEffect=(f,d)=>R().useEffect(f,d),useCallback=(f,d)=>R().useMemo(()=>f,d),useMemo=(f,d)=>R().useMemo(f,d);
  export default {};`;
const supabase = `export const isAuthSessionMissingError=()=>false;export const isAuthRetryableFetchError=e=>e?.name==='AuthRetryableFetchError';
  export const createClient=()=>({auth:{getUser:async()=>globalThis.__auth.getUser(),getSession:async()=>globalThis.__auth.session?.()??({data:{session:{user:globalThis.__auth.user,access_token:'t'}},error:null}),
    onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}}),signOut:async()=>({error:null})},
    from:table=>{const q={select:()=>q,eq:()=>q,ilike:()=>q,maybeSingle:async()=>globalThis.__auth.allow(),single:async()=>({data:{id:'u1',role:'user'},error:null})};return q;}});`;
const fixtures = { react, 'jsx-runtime': 'export const jsx=(type,props)=>({type,props}),jsxs=jsx,Fragment="Fragment";', 'supabase-js': supabase,
  runtimeConfig: 'export const getWorkspaceConfig=()=>({mode:"cloud"});export const isLocalWorkspace=()=>false;export const getCloudPublicConfig=()=>({supabaseUrl:"https://example.invalid",supabasePublishableKey:"k"});',
  browserClient: 'export const createLocalWorkspaceClient=()=>({});', storageService: 'export const clearLocalMediaCache=async()=>{};',
  LoginScreen: 'export const LoginScreen=({isUnauthorized})=>isUnauthorized?"UNAUTHORIZED":"LOGIN";' };
const compiled = await build({entryPoints:['src/components/AuthBoundary.tsx'],absWorkingDir:fileURLToPath(new URL('..',import.meta.url)),bundle:true,write:false,format:'esm',platform:'node',jsx:'automatic',logLevel:'silent',
  plugins:[{name:'fixture',setup(b){
    b.onResolve({filter:/^(react|react\/jsx-runtime|@supabase\/supabase-js)$|\/(runtimeConfig|browserClient|storageService|LoginScreen)$/},args=>({path:args.path.split('/').at(-1),namespace:'fixture'}));
    b.onLoad({filter:/.*/,namespace:'fixture'},args=>({loader:'js',contents:fixtures[args.path]}));
  }}]});
const { AuthBoundary } = await import('data:text/javascript;base64,'+Buffer.from(compiled.outputFiles[0].text).toString('base64'));

const user = { id: 'u1', email: 'member@example.com', email_confirmed_at: '2026-01-01' };
const offline = { data: { user: null }, error: Object.assign(new Error('Failed to fetch'), { name: 'AuthRetryableFetchError', status: 0 }) };
const listeners = {};
const settle = async () => { for (let i = 0; i < 40; i++) await new Promise(r => setImmediate(r)); };
const mount = () => {
  const slots = []; let cursor = 0, tree, effects, pending = false;
  const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  globalThis.__renderer = {
    useState(init) { const i = cursor++; if (!(i in slots)) slots[i] = { v: init }; return [slots[i].v, next => { slots[i].v = typeof next === 'function' ? next(slots[i].v) : next; schedule(); }]; },
    useRef(init) { const i = cursor++; if (!(i in slots)) slots[i] = { current: init }; return slots[i]; },
    useMemo(make, deps) { const i = cursor++; if (!(i in slots) || !same(slots[i].deps, deps)) slots[i] = { v: make(), deps }; return slots[i].v; },
    useEffect(run, deps) { const i = cursor++; const prev = slots[i]; if (!prev || !deps || !same(prev.deps, deps)) effects.push(() => { prev?.cleanup?.(); slots[i] = { deps, cleanup: run() }; }); },
  };
  const render = () => { cursor = 0; effects = []; const node = AuthBoundary({ children: () => 'WORKSPACE' });
    // The login screen is a component, the workspace a fragment and loading a spinner div.
    tree = typeof node?.type === 'function' ? node.type(node.props) : node?.type === 'Fragment' ? node.props.children : 'LOADING'; effects.forEach(run => run()); };
  const schedule = () => { if (!pending) { pending = true; queueMicrotask(() => { pending = false; render(); }); } };
  render();
  return { view: () => tree, refresh: async () => { for (const run of listeners.visibilitychange || []) run(); await settle(); } };
};

function setup(t) {
  const previous = { window: globalThis.window, document: globalThis.document, setTimeout: globalThis.setTimeout };
  for (const key of Object.keys(listeners)) delete listeners[key];
  const listen = (type, run) => { (listeners[type] ||= []).push(run); };
  // The retry backoff runs without waiting; the order of events is unchanged.
  globalThis.setTimeout = (run, _ms, ...args) => setImmediate(run, ...args);
  globalThis.window = { location: { origin: 'https://example.invalid', hash: '', pathname: '/', search: '' }, setTimeout: globalThis.setTimeout, setInterval: () => 1, clearInterval() {}, addEventListener: listen, removeEventListener() {} };
  globalThis.document = { visibilityState: 'visible', addEventListener: listen, removeEventListener() {} };
  globalThis.__auth = { user, getUser: async () => ({ data: { user }, error: null }), allow: async () => ({ data: { email: user.email }, error: null, status: 200 }) };
  t.after(() => Object.assign(globalThis, previous));
}

test('a refresh that cannot reach the server keeps the verified workspace open', async t => {
  setup(t);
  const boundary = mount(); await settle();
  assert.equal(boundary.view(), 'WORKSPACE');
  globalThis.__auth.getUser = async () => offline;
  await boundary.refresh();
  assert.equal(boundary.view(), 'WORKSPACE');
  globalThis.__auth.getUser = async () => ({ data: { user }, error: null });
  globalThis.__auth.allow = async () => ({ data: null, error: { message: 'TypeError: Failed to fetch', code: '' }, status: 0 });
  await boundary.refresh();
  assert.equal(boundary.view(), 'WORKSPACE');
});

test('a removed account is still closed, also after an offline refresh', async t => {
  setup(t);
  const boundary = mount(); await settle();
  globalThis.__auth.getUser = async () => offline;
  await boundary.refresh();
  globalThis.__auth.getUser = async () => ({ data: { user }, error: null });
  globalThis.__auth.allow = async () => ({ data: null, error: null, status: 200 });
  await boundary.refresh();
  assert.equal(boundary.view(), 'UNAUTHORIZED');
});

test('an unreachable first check grants nothing', async t => {
  setup(t);
  globalThis.__auth.getUser = async () => offline;
  const boundary = mount(); await settle();
  assert.equal(boundary.view(), 'UNAUTHORIZED');
});

test('an expired session that cannot be refreshed offline keeps the workspace; a revoked one closes it', async t => {
  setup(t);
  const boundary = mount(); await settle();
  // Waking after the access token expired: the refresh request cannot reach the server.
  globalThis.__auth.session = () => ({ data: { session: null }, error: offline.error });
  await boundary.refresh();
  assert.equal(boundary.view(), 'WORKSPACE');
  globalThis.__auth.session = () => ({ data: { session: null }, error: Object.assign(new Error('Invalid Refresh Token'), { name: 'AuthApiError', status: 400 }) });
  await boundary.refresh();
  assert.equal(boundary.view(), 'UNAUTHORIZED');
});
