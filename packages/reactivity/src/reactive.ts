//工具函数
import {
  isObject, // 判断是否是对象
  toRawType, // 获取数据的类型字符串形式，例如 "[object RawType]
  def //给对象定义属性，内部使用  Object.defineProperty
} from '@vue/shared'
//普通引用类型数据(Object,Array)handler集 ,最终会传给 Proxy 的第二个参数
import {
  mutableHandlers, // 可变数据代理handler
  readonlyHandlers, //只读数据代理handler
  shallowReactiveHandlers, //浅模式可变数据代理handler
  shallowReadonlyHandlers //浅模式不可变数据代理handler
} from './baseHandlers'
//集合类型数据(Set, Map, WeakMap, WeakSet)handler集 ,最终也会传给 Proxy 的第二个参数
import {
  mutableCollectionHandlers, //可变数据代理handler
  readonlyCollectionHandlers, //只读数据代理handler
  shallowCollectionHandlers //浅模式可变数据代理handler
} from './collectionHandlers'
//ref 中的类型定义
import {
  UnwrapRef, //解套的Ref类型
  Ref //Ref 类型
} from './ref'
//定义枚举常量标识
export const enum ReactiveFlags {
  SKIP = '__v_skip', //布尔类型，跳过 Proxy 的转换，被该属性标记的对象，不能被响应式化
  IS_REACTIVE = '__v_isReactive', //布尔类型，是否是一个响应式代理对象
  IS_READONLY = '__v_isReadonly', //布尔类型，是否是一个只读对象
  RAW = '__v_raw' //值类型，存储响应式对象的原始对象
}
//定义目标对象类型接口
export interface Target {
  [ReactiveFlags.SKIP]?: boolean
  [ReactiveFlags.IS_REACTIVE]?: boolean
  [ReactiveFlags.IS_READONLY]?: boolean
  [ReactiveFlags.RAW]?: any
}

//存储 原始对象 跟 代理对象 映射关系的集合
export const reactiveMap = new WeakMap<Target, any>()
export const readonlyMap = new WeakMap<Target, any>()

//定义目标对象类型的枚举常量标识
const enum TargetType {
  INVALID = 0, //标识无效类型
  COMMON = 1, //Object,Array
  COLLECTION = 2 //集合
}
//目标对象类型映射表
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
//获取目标对象类型
function getTargetType(value: Target) {
  return value[ReactiveFlags.SKIP] || !Object.isExtensible(value)
    ? TargetType.INVALID
    : targetTypeMap(toRawType(value))
}

// only unwrap nested ref
type UnwrapNestedRefs<T> = T extends Ref ? T : UnwrapRef<T>

//reactive 函数类型声明，接受一个对象，返回一个不会深度嵌套的Ref类型数据
export function reactive<T extends object>(target: T): UnwrapNestedRefs<T>

//reactive 函数实现
export function reactive(target: object) {
  // if trying to observe a readonly proxy, return the readonly version.
  //如果传入的目标对象是一个只读响应式对象,则将其直接返回
  if (target && (target as Target)[ReactiveFlags.IS_READONLY]) {
    return target
  }
  //调用createReactiveObject创建目标对象对应的响应式对象
  return createReactiveObject(
    target, //目标对象
    false, //目标对象是否是只读的
    mutableHandlers, //可变普通对象的代理handler，Object和Array
    mutableCollectionHandlers // 可变集合对象的代理handler，Set、Map、WeakMap、WeakSet
  )
}

// Return a reactive-copy of the original object, where only the root level
// properties are reactive, and does NOT unwrap refs nor recursively convert
// returned properties.
//只为某个对象的私有（第一层）属性创建浅层的响应式代理，不会对“属性的属性”做深层次、递归地响应式代理，而只是保留原样。
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

//传入一个对象（响应式或普通）或 ref，返回一个原始对象的只读代理。一个只读的代理是“深层的”，对象内部任何嵌套的属性也都是只读的。
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
//只为某个对象的自有（第一层）属性创建浅层的只读响应式代理,不会做深层次、递归地代理，深层次的属性并不是只读的
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
//创建响应式对象的方法，接收一个普通对象然后返回该普通对象的响应式代理。
function createReactiveObject(
  target: Target, //目标对象
  isReadonly: boolean, //目标对象是否是只读的
  baseHandlers: ProxyHandler<any>, //可变普通对象的代理handler，Object和Array
  collectionHandlers: ProxyHandler<any> // 可变集合对象的代理handler，Set、Map、WeakMap、WeakSet
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
  //如果目标对象已经是一个响应式代理了,则直接返回,(但是在响应式对象上调用readonly方法这种情况除外，意思是readonly可以继续处理响应式对象)
  if (
    target[ReactiveFlags.RAW] &&
    !(isReadonly && target[ReactiveFlags.IS_REACTIVE])
  ) {
    return target
  }
  // target already has corresponding Proxy
  //如果目标对象已经有了相应的proxy代理(首次 createReactive 时候会往 readonlyMap或者reactiveMap 存入rawObj -> proxy 关系,所以可以检测出来),
  //则从map集合里取出对应的代理对象（同一个原始对象只能有一个代理对象，不能重复代理）
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
  //创建并返回代理对象,这里需要注意集合类型和Object/Array的响应式handler(第二个参数),内部会有不同
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
  //如果这个代理是由 readonly 创建的，但是又被 reactive 创建的另一个代理包裹了一层，那么同样也会返回 true。
  if (isReadonly(value)) {
    return isReactive((value as Target)[ReactiveFlags.RAW])
  }
  return !!(value && (value as Target)[ReactiveFlags.IS_REACTIVE])
}
//检查一个对象是否是由 readonly 创建的只读代理。
export function isReadonly(value: unknown): boolean {
  return !!(value && (value as Target)[ReactiveFlags.IS_READONLY])
}
//检查一个对象是否是由 reactive 或者 readonly 方法创建的代理。
export function isProxy(value: unknown): boolean {
  return isReactive(value) || isReadonly(value)
}

//返回由 reactive 或 readonly 方法转换成响应式代理的普通对象
export function toRaw<T>(observed: T): T {
  return (
    (observed && toRaw((observed as Target)[ReactiveFlags.RAW])) || observed
  )
}
//显式标记一个对象为“永远不会转为响应式代理”，函数返回这个对象本身。
export function markRaw<T extends object>(value: T): T {
  //def方法内部调用Object.defineProperty(),然后会给value内部定义属性 __v_skip = true,打上该标记后，在createReactiveObject()方法中检测传入对象如果
  //含有__v_skip = true属性则会被判定为无效类型，直接返回对象本身
  def(value, ReactiveFlags.SKIP, true)
  return value
}
