'use client';

import { authAPI } from '@/lib/api';
import { getPublicEnv } from '@/lib/env';
import {
    web3TransactionMachine,
    type Web3TransactionContext,
    type Web3TransactionStatus,
} from '@/lib/web3/transactionMachine';
import { useMachine } from '@xstate/react';
import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';

export type StellarNetwork = 'PUBLIC' | 'TESTNET' | 'FUTURENET';

export const NETWORK_PASSPHRASES: Record<StellarNetwork, string> = {
  PUBLIC: 'Public Global Stellar Network ; September 2015',
  TESTNET: 'Test SDF Network ; September 2015',
  FUTURENET: 'Test SDF Future Network ; October 2022',
};

export interface WalletProvider {
  id: string;
  kitId?: string;
  name: string;
  recommended?: boolean;
  icon: string;
  downloadUrl: string;
  description: string;
  isInstalled: () => boolean;
  connect: (network?: StellarNetwork) => Promise<string>;
  disconnect: (network?: StellarNetwork) => Promise<void>;
  getPublicKey: (network?: StellarNetwork) => Promise<string | null>;
  getNetwork?: (network?: StellarNetwork) => Promise<StellarNetwork | string | null>;
  switchNetwork?: (network: StellarNetwork) => Promise<boolean>;
  signTransaction: (xdr: string, opts?: { networkPassphrase?: string }) => Promise<string>;
  onAccountChange?: (cb: (pk: string | null) => void) => () => void;
  onNetworkChange?: (cb: (net: StellarNetwork | string) => void) => () => void;
}

declare global {
  interface Window {
    freighter?: {
      isConnected: () => Promise<boolean | { isConnected: boolean; error?: string }>;
      requestAccess?: () => Promise<{ address: string; error?: string }>;
      getAddress?: () => Promise<{ address: string; error?: string }>;
      getPublicKey?: () => Promise<string>;
      getNetwork?: () => Promise<string>;
      setNetwork?: (network: string) => Promise<boolean>;
      signTransaction: (
        xdr: string,
        opts?: object
      ) => Promise<string | { signedTxXdr: string; signerAddress: string; error?: string }>;
    };
    freighterApi?: {
      isConnected?: () => Promise<boolean | { isConnected: boolean; error?: string }>;
      requestAccess?: () => Promise<{ address: string; error?: string }>;
      getAddress?: () => Promise<{ address: string; error?: string }>;
      getPublicKey?: () => Promise<string>;
      getNetwork?: () => Promise<string>;
      signTransaction: (
        xdr: string,
        opts?: object
      ) => Promise<string | { signedTxXdr: string; signerAddress: string; error?: string }>;
    };
    stellar?: {
      freighter?: {
        isConnected?: () => Promise<boolean | { isConnected: boolean; error?: string }>;
        requestAccess?: () => Promise<{ address: string; error?: string }>;
        getAddress?: () => Promise<{ address: string; error?: string }>;
        getPublicKey?: () => Promise<string>;
        getNetwork?: () => Promise<string>;
        signTransaction: (
          xdr: string,
          opts?: object
        ) => Promise<string | { signedTxXdr: string; signerAddress: string; error?: string }>;
      };
      hana?: {
        connect: () => Promise<{ publicKey: string }>;
        getPublicKey: () => Promise<string>;
        signTransaction: (xdr: string) => Promise<string>;
      };
    };
    albedo?: {
      publicKey: (opts?: object) => Promise<{ pubkey: string }>;
      tx: (opts: { xdr: string; network: string }) => Promise<{ signed_envelope_xdr: string }>;
    };
    rabet?: {
      connect: () => Promise<{ publicKey: string }>;
      sign: (xdr: string, network: string) => Promise<{ xdr: string }>;
    };
    hana?: {
      connect: () => Promise<{ publicKey: string }>;
      getPublicKey: () => Promise<string>;
      signTransaction: (xdr: string) => Promise<string>;
    };
    xBull?: {
      connect: () => Promise<{ publicKey: string }>;
      getPublicKey: () => Promise<string>;
      sign: (xdr: string, opts?: object) => Promise<string>;
    };
    xBullSDK?: {
      connect: () => Promise<{ publicKey: string }>;
      getPublicKey: () => Promise<string>;
      sign: (xdr: string, opts?: object) => Promise<string>;
    };
    walletConnect?: {
      connect: () => Promise<{ account: string }>;
      sign: (xdr: string) => Promise<string>;
    };
  }
}

const resolveInjectedFreighter = () =>
  typeof window === 'undefined'
    ? null
    : window.freighterApi || window.freighter || window.stellar?.freighter || null;

const KIT_NETWORKS: Record<StellarNetwork, KitNetwork> = {
  PUBLIC: KitNetwork.PUBLIC,
  TESTNET: KitNetwork.TESTNET,
  FUTURENET: KitNetwork.FUTURENET,
};

interface WalletKitState {
  kit: StellarWalletsKit;
  walletConnect: WalletConnectModule | null;
}

const walletKits = new Map<StellarNetwork, WalletKitState>();

function getWalletKit(network: StellarNetwork): WalletKitState {
  const cached = walletKits.get(network);
  if (cached) return cached;

  const modules: ModuleInterface[] = [
    new FreighterModule(),
    new AlbedoModule(),
    new RabetModule(),
    new HanaModule(),
    new xBullModule(),
  ];
  const projectId = getPublicEnv().walletConnectProjectId;
  let walletConnect: WalletConnectModule | null = null;

  if (projectId && network !== 'FUTURENET') {
    walletConnect = new WalletConnectModule({
      projectId,
      name: 'Web3 Student Lab',
      description: 'Connect a Stellar wallet to Web3 Student Lab.',
      url: typeof window === 'undefined' ? 'https://web3studentlab.org' : window.location.origin,
      icons: [],
      method: WalletConnectAllowedMethods.SIGN,
      network: KIT_NETWORKS[network],
    });
    modules.push(walletConnect);
  }

  const state = {
    kit: new StellarWalletsKit({
      network: KIT_NETWORKS[network],
      selectedWalletId: FREIGHTER_ID,
      modules,
    }),
    walletConnect,
  };
  walletKits.set(network, state);
  return state;
}

function getWalletProvider(
  options: Omit<WalletProvider, 'connect' | 'disconnect' | 'getPublicKey' | 'getNetwork' | 'signTransaction' | 'switchNetwork'> & {
    kitId: string;
  }
): WalletProvider {
  const useKit = async (network: StellarNetwork, action: (kit: StellarWalletsKit) => Promise<void>) => {
    const { kit } = getWalletKit(network);
    kit.setWallet(options.kitId);
    await action(kit);
  };

  return {
    ...options,
    connect: async (network = 'TESTNET') => {
      let address = '';
      await useKit(network, async (kit) => {
        address = (await kit.getAddress()).address;
      });
      if (!address) throw new Error(`${options.name} did not return an account.`);
      return address;
    },
    disconnect: async (network = 'TESTNET') => {
      const state = getWalletKit(network);
      if (options.kitId === WALLET_CONNECT_ID) await state.walletConnect?.disconnect();
      await state.kit.disconnect();
    },
    getPublicKey: async (network = 'TESTNET') => {
      try {
        let address: string | null = null;
        await useKit(network, async (kit) => {
          address = (await kit.getAddress()).address;
        });
        return address;
      } catch {
        return null;
      }
    },
    getNetwork: async (network = 'TESTNET') => {
      let networkPassphrase: string | null = null;
      await useKit(network, async (kit) => {
        networkPassphrase = (await kit.getNetwork()).networkPassphrase;
      });
      return networkPassphrase;
    },
    switchNetwork:
      options.id === 'freighter'
        ? async (network) => {
            const injected = resolveInjectedFreighter();
            if (!injected?.setNetwork) return false;
            try {
              return await injected.setNetwork(network);
            } catch {
              return false;
            }
          }
        : undefined,
    signTransaction: async (xdr, opts) => {
      const network =
        (Object.entries(NETWORK_PASSPHRASES).find(([, passphrase]) =>
          opts?.networkPassphrase?.includes(passphrase)
        )?.[0] as StellarNetwork | undefined) ?? 'TESTNET';
      let signedXdr = '';
      await useKit(network, async (kit) => {
        signedXdr = (await kit.signTransaction(xdr, opts)).signedTxXdr;
      });
      if (!signedXdr) throw new Error(`${options.name} did not return a signed transaction.`);
      return signedXdr;
    },
  };
}

const freighterAdapter = getWalletProvider({
  id: 'freighter',
  kitId: FREIGHTER_ID,
  name: 'Freighter',
  recommended: true,
  icon: '🚀',
  downloadUrl: 'https://www.freighter.app',
  description: 'Browser extension wallet for the Stellar network.',
  isInstalled: () =>
    typeof window !== 'undefined' &&
    (!!window.freighter || !!window.freighterApi || !!window.stellar?.freighter),
});

const albedoAdapter = getWalletProvider({
  id: 'albedo',
  kitId: ALBEDO_ID,
  name: 'Albedo',
  icon: '🌐',
  downloadUrl: 'https://albedo.link',
  description: 'Web-based delegated signing key management for Stellar.',
  isInstalled: () => process.env.NODE_ENV !== 'production',
});

const rabetAdapter = getWalletProvider({
  id: 'rabet',
  kitId: RABET_ID,
  name: 'Rabet',
  icon: '🔷',
  downloadUrl: 'https://rabet.io',
  description: 'Browser extension wallet for Stellar.',
  isInstalled: () => typeof window !== 'undefined' && !!window.rabet,
});

const hanaAdapter = getWalletProvider({
  id: 'hana',
  kitId: HANA_ID,
  name: 'Hana',
  icon: '🌸',
  downloadUrl: 'https://hanawallet.io',
  description: 'Multi-chain non-custodial Web3 wallet extension.',
  isInstalled: () => typeof window !== 'undefined' && (!!window.hana || !!window.stellar?.hana),
});

const xBullAdapter = getWalletProvider({
  id: 'xbull',
  kitId: XBULL_ID,
  name: 'xBull',
  icon: '🐂',
  downloadUrl: 'https://xbull.app',
  description: 'Stellar wallet extension and mobile app.',
  isInstalled: () => typeof window !== 'undefined' && (!!window.xBull || !!window.xBullSDK),
});

const walletConnectAdapter = getWalletProvider({
  id: 'walletconnect',
  kitId: WALLET_CONNECT_ID,
  name: 'WalletConnect',
  icon: '🔗',
  downloadUrl: 'https://walletconnect.com',
  description: 'Pair a mobile Stellar wallet with a QR code or deep link.',
  isInstalled: () =>
    typeof window !== 'undefined' && Boolean(getPublicEnv().walletConnectProjectId),
});

const mockAdapter: WalletProvider = {
  id: 'mock',
  name: 'Dev Mock Wallet',
  icon: '🛠️',
  downloadUrl: 'https://stellar.org',
  description: 'Development sandbox wallet for isolated local testing.',
  isInstalled: () => true,
  connect: async () => 'GBRPYHIL2CI3FYQMWVUGE62KMGOBQKLCYJ3HLKBUBIW5VZH4S4MNOWT',
  disconnect: async () => {},
  getPublicKey: async () => 'GBRPYHIL2CI3FYQMWVUGE62KMGOBQKLCYJ3HLKBUBIW5VZH4S4MNOWT',
  getNetwork: async () => 'TESTNET',
  signTransaction: async (xdr) => xdr,
};

export const WALLET_PROVIDERS: WalletProvider[] = [
  freighterAdapter,
  albedoAdapter,
  rabetAdapter,
  hanaAdapter,
  xBullAdapter,
  walletConnectAdapter,
  ...(process.env.NODE_ENV !== 'production' ? [mockAdapter] : []),
];

function findWalletProvider(providerName: string): WalletProvider | undefined {
  const normalizedName = providerName.trim().toLowerCase();
  return WALLET_PROVIDERS.find(
    (provider) =>
      provider.id.toLowerCase() === normalizedName || provider.name.toLowerCase() === normalizedName
  );
}

interface WalletContextType {
  publicKey: string | null;
  activeWallet: string | null;
  isConnecting: boolean;
  isConnected: boolean;
  connected: boolean;
  error: string | null;
  activeNetwork: StellarNetwork;
  walletNetwork: StellarNetwork | null;
  isNetworkDivergent: boolean;
  blockHeight: number | null;
  balances: Record<StellarNetwork, string>;
  availableWallets: WalletProvider[];
  detectedWallets: WalletProvider[];
  transactionState: Web3TransactionStatus;
  transactionContext: Web3TransactionContext;
  connect: (providerName: string) => Promise<void>;
  authenticateWithWallet: (providerName: string) => Promise<any>;
  disconnect: () => Promise<void>;
  signTransaction: (xdr: string, opts?: { networkPassphrase?: string }) => Promise<string>;
  switchNetwork: (network: StellarNetwork) => Promise<void>;
  setAppNetwork: (network: StellarNetwork) => void;
}

const WalletContext = createContext<WalletContextType | undefined>(undefined);

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [activeWallet, setActiveWallet] = useState<string | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeNetwork, setActiveNetwork] = useState<StellarNetwork>('TESTNET');
  const [walletNetwork, setWalletNetwork] = useState<StellarNetwork | null>(null);
  const [blockHeight, setBlockHeight] = useState<number | null>(4819200);
  const [detectedWallets, setDetectedWallets] = useState<WalletProvider[]>([]);
  const [transactionSnapshot, sendTransaction] = useMachine(web3TransactionMachine);

  const [balances, setBalances] = useState<Record<StellarNetwork, string>>({
    PUBLIC: '0.0000000 XLM',
    TESTNET: '10000.0000000 XLM (Testnet)',
    FUTURENET: '1000.0000000 XLM (Futurenet)',
  });

  const scanWallets = useCallback(async () => {
    const state = getWalletKit(activeNetwork);
    try {
      const supportedWallets = await state.kit.getSupportedWallets();
      const supportedIds = new Set(
        supportedWallets.filter((wallet) => wallet.isAvailable).map((wallet) => wallet.id)
      );
      setDetectedWallets(
        WALLET_PROVIDERS.filter(
          (provider) =>
            (provider.id !== 'walletconnect' || activeNetwork !== 'FUTURENET') &&
            (provider.isInstalled() || supportedIds.has(provider.kitId ?? provider.id))
        )
      );
    } catch {
      setDetectedWallets(WALLET_PROVIDERS.filter((provider) => provider.isInstalled()));
    }
  }, [activeNetwork]);

  useEffect(() => {
    scanWallets();
    const timer = setInterval(scanWallets, 1500);
    window.addEventListener('focus', scanWallets);
    document.addEventListener('visibilitychange', scanWallets);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', scanWallets);
      document.removeEventListener('visibilitychange', scanWallets);
    };
  }, [scanWallets]);

  useEffect(() => {
    const interval = setInterval(() => {
      setBlockHeight((prev) => (prev !== null ? prev + 1 : 4819200));
    }, 5000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const saved = localStorage.getItem('stellar_wallet');
    if (saved) {
      try {
        const { wallet, pk, network } = JSON.parse(saved);
        setActiveWallet(wallet);
        setPublicKey(pk);
        if (network && ['PUBLIC', 'TESTNET', 'FUTURENET'].includes(network)) {
          setActiveNetwork(network);
        }
        sendTransaction({ type: 'WALLET_CONNECTED', walletName: wallet, publicKey: pk });
      } catch {
        localStorage.removeItem('stellar_wallet');
      }
    }
  }, [sendTransaction]);

  const updateWalletNetwork = useCallback(async (provider: WalletProvider, network: StellarNetwork) => {
    if (provider.getNetwork) {
      try {
        const net = await provider.getNetwork(network);
        if (net && ['PUBLIC', 'TESTNET', 'FUTURENET'].includes(net.toUpperCase())) {
          setWalletNetwork(net.toUpperCase() as StellarNetwork);
        }
      } catch {
        setWalletNetwork(null);
      }
    }
  }, []);

  const connect = useCallback(
    async (providerName: string) => {
      const provider = findWalletProvider(providerName);
      if (!provider) throw new Error(`Unknown wallet: ${providerName}`);
      setIsConnecting(true);
      setError(null);
      sendTransaction({ type: 'CONNECT_WALLET', walletName: provider.name });
      try {
        const pk = await provider.connect(activeNetwork);
        setPublicKey(pk);
        setActiveWallet(provider.name);
        await updateWalletNetwork(provider, activeNetwork);
        localStorage.setItem(
          'stellar_wallet',
          JSON.stringify({ wallet: provider.name, pk, network: activeNetwork })
        );
        sendTransaction({ type: 'WALLET_CONNECTED', walletName: provider.name, publicKey: pk });
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'Connection failed';
        setError(msg);
        sendTransaction({ type: 'FAIL', error: msg });
        throw e;
      } finally {
        setIsConnecting(false);
      }
    },
    [activeNetwork, sendTransaction, updateWalletNetwork]
  );

  const authenticateWithWallet = useCallback(
    async (providerName: string) => {
      const provider = findWalletProvider(providerName);
      if (!provider) throw new Error(`Unknown wallet: ${providerName}`);

      setIsConnecting(true);
      setError(null);
      sendTransaction({ type: 'CONNECT_WALLET', walletName: providerName });

      try {
        const pk = await provider.connect(activeNetwork);
        setPublicKey(pk);
        setActiveWallet(provider.name);
        localStorage.setItem(
          'stellar_wallet',
          JSON.stringify({ wallet: provider.name, pk, network: activeNetwork })
        );
        sendTransaction({ type: 'WALLET_CONNECTED', walletName: provider.name, publicKey: pk });

        // 1. Request SEP-0010 Challenge Transaction from Backend
        const challengeRes = await authAPI.getSep10Challenge(pk);
        if (!challengeRes?.transaction) {
          throw new Error('Server failed to generate SEP-0010 challenge');
        }

        // 2. Sign Challenge Transaction with Wallet
        sendTransaction({ type: 'REQUEST_SIGNATURE', transactionXdr: challengeRes.transaction });
        const signedXdr = await provider.signTransaction(challengeRes.transaction, {
          networkPassphrase: NETWORK_PASSPHRASES[activeNetwork],
        });
        sendTransaction({ type: 'SIGNATURE_APPROVED', signedTransactionXdr: signedXdr });

        // 3. Submit Signed Challenge to Backend for Verification & Token Issuance
        const authResponse = await authAPI.verifySep10Challenge(signedXdr);

        if (authResponse?.token) {
          localStorage.setItem('token', authResponse.token);
          localStorage.setItem('user', JSON.stringify(authResponse.user));
        }

        return authResponse;
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'Wallet authentication failed';
        setError(msg);
        sendTransaction({ type: 'FAIL', error: msg });
        throw e;
      } finally {
        setIsConnecting(false);
      }
    },
    [activeNetwork, sendTransaction]
  );

  const disconnect = useCallback(async () => {
    const provider = activeWallet ? findWalletProvider(activeWallet) : undefined;
    await provider?.disconnect(activeNetwork);
    setPublicKey(null);
    setActiveWallet(null);
    setWalletNetwork(null);
    localStorage.removeItem('stellar_wallet');
    sendTransaction({ type: 'DISCONNECT_WALLET' });
  }, [activeNetwork, activeWallet, sendTransaction]);

  const setAppNetwork = useCallback((network: StellarNetwork) => {
    setActiveNetwork(network);
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('stellar_wallet');
      if (saved) {
        try {
          const parsed = JSON.parse(saved);
          localStorage.setItem(
            'stellar_wallet',
            JSON.stringify({ ...parsed, network })
          );
        } catch {}
      }
    }
  }, []);

  const switchNetwork = useCallback(
    async (targetNetwork: StellarNetwork) => {
      const provider = activeWallet ? findWalletProvider(activeWallet) : undefined;
      if (provider?.switchNetwork) {
        const success = await provider.switchNetwork(targetNetwork);
        if (success) {
          setWalletNetwork(targetNetwork);
        }
      }
      setAppNetwork(targetNetwork);
    },
    [activeWallet, setAppNetwork]
  );

  const isNetworkDivergent =
    walletNetwork !== null && walletNetwork !== activeNetwork;

  const signTransaction = useCallback(
    async (xdr: string, opts?: { networkPassphrase?: string }) => {
      if (isNetworkDivergent) {
        throw new Error(
          `Network mismatch: Application is set to ${activeNetwork} while wallet is connected to ${walletNetwork}. Please switch networks before signing.`
        );
      }
      const provider = activeWallet ? findWalletProvider(activeWallet) : undefined;
      if (!provider) throw new Error('No wallet connected');
      sendTransaction({ type: 'REQUEST_SIGNATURE', transactionXdr: xdr });
      try {
        const targetPassphrase = opts?.networkPassphrase || NETWORK_PASSPHRASES[activeNetwork];
        const signedXdr = await provider.signTransaction(xdr, {
          networkPassphrase: targetPassphrase,
        });
        sendTransaction({ type: 'SIGNATURE_APPROVED', signedTransactionXdr: signedXdr });
        return signedXdr;
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'Transaction signing failed';
        sendTransaction({ type: 'FAIL', error: msg });
        throw e;
      }
    },
    [activeNetwork, activeWallet, isNetworkDivergent, sendTransaction, walletNetwork]
  );

  return (
    <WalletContext.Provider
      value={{
        publicKey,
        activeWallet,
        isConnecting,
        isConnected: !!publicKey,
        connected: !!publicKey,
        error,
        activeNetwork,
        walletNetwork,
        isNetworkDivergent,
        blockHeight,
        balances,
        availableWallets: WALLET_PROVIDERS,
        detectedWallets,
        transactionState: transactionSnapshot.value as Web3TransactionStatus,
        transactionContext: transactionSnapshot.context,
        connect,
        authenticateWithWallet,
        disconnect,
        signTransaction,
        switchNetwork,
        setAppNetwork,
      }}
    >
      {children}
    </WalletContext.Provider>
  );
}

export function useWallet() {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error('useWallet must be used within WalletProvider');
  return ctx;
}
