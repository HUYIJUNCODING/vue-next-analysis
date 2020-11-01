import { isObject, toRawType, def } from '@vue/shared'
import {
  mutableHandlers,
  readonlyHandlers,
  shallowReactiveHandlers,
  shallowReadonlyHandlers
} from './baseHandlers'
import {
  mutableCollectionHandlers,
  readonlyCollectionHandlers,
  shallowCollectionHandlers
} from './collectionHandlers'
import { UnwrapRef, Ref } from './ref'

export const enum ReactiveFlags {
  SKIP = '__v_skip',
  IS_REACTIVE = '__v_isReactive',
  IS_READONLY = '__v_isReadonly',
  RAW = '__v_raw'
}

export interface Target {
  [ReactiveFlags.SKIP]?: boolean
  [ReactiveFlags.IS_REACTIVE]?: boolean
  [ReactiveFlags.IS_READONLY]?: boolean
  [ReactiveFlags.RAW]?: any
}

export const reactiveMap = new WeakMap<Target, any>()
export const readonlyMap = new WeakMap<Target, any>()

const enum TargetType {
  INVALID = 0,
  COMMON = 1,
  COLLECTION = 2
}

function targetTypeMap(rawType: string) {
  switch (rawType) {
    case 'Object':
    case 'Array':
      return TargetType.COMMON
    case 'Map':
    case 'Set':
    case 'WeakMap':
    case 'WeakSet':
      return TargetType.COLLECTION
    default:
      return TargetType.INVALID
  }
}

function getTargetType(value: Target) {
  return value[ReactiveFlags.SKIP] || !Object.isExtensible(value)
    ? TargetType.INVALID
    : targetTypeMap(toRawType(value))
}

// only unwrap nested ref
type UnwrapNestedRefs<T> = T extends Ref ? T : UnwrapRef<T>

export function reactive<T extends object>(target: T): UnwrapNestedRefs<T>

//接收一个普通对象然后返回该普通对象的响应式代理.
export function reactive(target: object) {
  // if trying to observe a readonly proxy, return the readonly version.
  //如果target是一个只读代理对象,则将其直接返回
  if (target && (target as Target)[ReactiveFlags.IS_READONLY]) {
    return target
  }
  //调用createReactiveObject创建reactive对象
  return createReactiveObject(
    target,//目标对象
    false,//目标对象是否只读
    mutableHandlers,//响应式数据的代理handler，一般是Object和Array
    mutableCollectionHandlers// 响应式集合的代理handler，一般是Set、Map、WeakMap、WeakSet
  )
}

// Return a reactive-copy of the original object, where only the root level
// properties are reactive, and does NOT unwrap refs nor recursively convert
// returned properties.
export function shallowReactive<T extends object>(target: T): T {
  return createReactiveObject(
    target,
    false,
    shallowReactiveHandlers,
    shallowCollectionHandlers
  )
}

type Primitive = string | number | boolean | bigint | symbol | undefined | null
type Builtin = Primitive | Function | Date | Error | RegExp
export type DeepReadonly<T> = T extends Builtin
  ? T
  : T extends Map<infer K, infer V>
    ? ReadonlyMap<DeepReadonly<K>, DeepReadonly<V>>
    : T extends ReadonlyMap<infer K, infer V>
      ? ReadonlyMap<DeepReadonly<K>, DeepReadonly<V>>
      : T extends WeakMap<infer K, infer V>
        ? WeakMap<DeepReadonly<K>, DeepReadonly<V>>
        : T extends Set<infer U>
          ? ReadonlySet<DeepReadonly<U>>
          : T extends ReadonlySet<infer U>
            ? ReadonlySet<DeepReadonly<U>>
            : T extends WeakSet<infer U>
              ? WeakSet<DeepReadonly<U>>
              : T extends Promise<infer U>
                ? Promise<DeepReadonly<U>>
                : T extends {}
                  ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
                  : Readonly<T>

export function readonly<T extends object>(
  target: T
): DeepReadonly<UnwrapNestedRefs<T>> {
  return createReactiveObject(
    target,
    true,
    readonlyHandlers,
    readonlyCollectionHandlers
  )
}

// Return a reactive-copy of the original object, where only the root level
// properties are readonly, and does NOT unwrap refs nor recursively convert
// returned properties.
// This is used for creating the props proxy object for stateful components.
export function shallowReadonly<T extends object>(
  target: T
): Readonly<{ [K in keyof T]: UnwrapNestedRefs<T[K]> }> {
  return createReactiveObject(
    target,
    true,
    shallowReadonlyHandlers,
    readonlyCollectionHandlers
  )
}
//接收一个普通对象然后返回该普通对象的响应式代理。等同于 2.x 的 Vue.observable()
function createReactiveObject(
  target: Target,
  isReadonly: boolean,
  baseHandlers: ProxyHandler<any>,
  collectionHandlers: ProxyHandler<any>
) {
  //如果不是对象,则直接返回,非对象类型不能代理(开发环境下会给出警告)
  if (!isObject(target)) {
    if (__DEV__) {
      console.warn(`value cannot be made reactive: ${String(target)}`)
    }
    return target
  }
  // target is already a Proxy, return it.
  // exception: calling readonly() on a reactive object
  //如果目标对象是一个非只读的proxy代理(响应式代理),则直接返回(传入的本身就是一个proxy代理，就不能去再去代理)
  if (
    target[ReactiveFlags.RAW] &&
    !(isReadonly && target[ReactiveFlags.IS_REACTIVE])
  ) {
    return target
  }
  // target already has corresponding Proxy
  //如果目标对象已经有了相应的proxy代理(首次 createReactive 时候会往 readonlyMap或者reactiveMap 存入rawObj -> proxy 关系,所以可以检测出来)
  const proxyMap = isReadonly ? readonlyMap : reactiveMap
  const existingProxy = proxyMap.get(target)
  if (existingProxy) {
    return existingProxy
  }
  // only a whitelist of value types can be observed.
  //getTargetType 方法内部会调用 targetTypeMap方法,然后会对target类型进行归类并返回其类型
  //Object,Array -> 1,Map,WeakMap,Set,WeakSet - > 2,其他无效类型(INVALID:无效类型)-> 0
  //如果传入的target类型无效则直接返回target
  const targetType = getTargetType(target)
  if (targetType === TargetType.INVALID) {
    return target
  }
  //创建代理对象并返回代理对象,这里需要注意集合类型和Object/Array的响应式handler(第二个参数),内部会有不同
  const proxy = new Proxy(
    target,
    targetType === TargetType.COLLECTION ? collectionHandlers : baseHandlers
  )
  //建立rawOject->proxy映射关系并存入 readonlyMap/reactiveMap
  proxyMap.set(target, proxy)
  return proxy
}

//检查一个对象是否是由 reactive 创建的响应式代理
export function isReactive(value: unknown): boolean {
  if (isReadonly(value)) {
    return isReactive((value as Target)[ReactiveFlags.RAW])
  }
  return !!(value && (value as Target)[ReactiveFlags.IS_REACTIVE])
}

export function isReadonly(value: unknown): boolean {
  return !!(value && (value as Target)[ReactiveFlags.IS_READONLY])
}

export function isProxy(value: unknown): boolean {
  return isReactive(value) || isReadonly(value)
}

//返回由 reactive 或 readonly 方法转换成响应式代理的普通对象
export function toRaw<T>(observed: T): T {
  return (
    (observed && toRaw((observed as Target)[ReactiveFlags.RAW])) || observed
  )
}

export function markRaw<T extends object>(value: T): T {
  def(value, ReactiveFlags.SKIP, true)
  return value
}
