// Service Registry for dependency injection and service management

export type ServiceToken<T = unknown> = symbol & { __type?: T };

export type ServiceFactory<T> = () => T;

export enum ServiceScope {
  Singleton = 'singleton',
  Transient = 'transient',
}

export interface ServiceDefinition<T> {
  token: ServiceToken<T>;
  factory: ServiceFactory<T>;
  scope: ServiceScope;
  instance?: T;
}

export interface LifecycleHooks {
  init?(): void | Promise<void>;
  dispose?(): void | Promise<void>;
}

export class ServiceRegistry {
  private static instance: ServiceRegistry;
  private services = new Map<ServiceToken, ServiceDefinition<unknown>>();

  private constructor() {}

  static getInstance(): ServiceRegistry {
    if (!ServiceRegistry.instance) {
      ServiceRegistry.instance = new ServiceRegistry();
    }
    return ServiceRegistry.instance;
  }

  register<T>(
    token: ServiceToken<T>,
    factory: ServiceFactory<T>,
    scope: ServiceScope = ServiceScope.Singleton,
  ): void {
    if (this.services.has(token)) {
      console.warn('Service already registered:', token.description);
      return;
    }

    this.services.set(token, {
      token,
      factory,
      scope,
    });
  }

  get<T>(token: ServiceToken<T>): T {
    const definition = this.services.get(token) as ServiceDefinition<T> | undefined;

    if (!definition) {
      throw new Error(`Service not registered: ${token.description}`);
    }

    if (definition.scope === ServiceScope.Singleton) {
      if (!definition.instance) {
        definition.instance = definition.factory();
        this.initializeService(definition.instance);
      }
      return definition.instance;
    }

    // Transient scope
    const instance = definition.factory();
    this.initializeService(instance);
    return instance;
  }

  has(token: ServiceToken): boolean {
    return this.services.has(token);
  }

  async disposeAll(): Promise<void> {
    const disposals: Promise<void>[] = [];

    for (const definition of this.services.values()) {
      if (definition.instance && this.hasLifecycleHooks(definition.instance)) {
        const disposal = definition.instance.dispose?.();
        if (disposal) {
          disposals.push(Promise.resolve(disposal));
        }
      }
    }

    await Promise.all(disposals);
    this.services.clear();
  }

  private initializeService(instance: unknown): void {
    if (this.hasLifecycleHooks(instance)) {
      const init = instance.init?.();
      if (init) {
        Promise.resolve(init).catch((err) => {
          console.error('Service initialization error:', err);
        });
      }
    }
  }

  private hasLifecycleHooks(obj: unknown): obj is LifecycleHooks {
    return typeof obj === 'object' && obj !== null && ('init' in obj || 'dispose' in obj);
  }
}

// Helper function to create service tokens
export function createServiceToken<T>(description: string): ServiceToken<T> {
  return Symbol(description) as ServiceToken<T>;
}
