import { mount } from "svelte";
import {
  AppStorage,
  CustomProvidersStore,
  IndexedDBStorageBackend,
  ProviderKeysStore,
  SessionsStore,
  SettingsStore,
  setAppStorage,
} from "@earendil-works/pi-web-ui";
import App from "./App.svelte";
import "./app.css";

// pi-web-ui requires an app storage instance before any component touches it
const settings = new SettingsStore();
const providerKeys = new ProviderKeysStore();
const sessions = new SessionsStore();
const customProviders = new CustomProvidersStore();

const backend = new IndexedDBStorageBackend({
  dbName: "gwarestrin",
  version: 2,
  stores: [
    settings.getConfig(),
    SessionsStore.getMetadataConfig(),
    providerKeys.getConfig(),
    customProviders.getConfig(),
    sessions.getConfig(),
  ],
});

settings.setBackend(backend);
providerKeys.setBackend(backend);
customProviders.setBackend(backend);
sessions.setBackend(backend);

setAppStorage(new AppStorage(settings, providerKeys, sessions, customProviders, backend));

const app = mount(App, { target: document.getElementById("app")! });

export default app;
