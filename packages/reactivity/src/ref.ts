import { track, trigger } from './effect'
import { TrackOpTypes, TriggerOpTypes } from './operations'
import { isArray, isObject, hasChanged } from '@vue/shared'
import { reactive, isProxy, toRaw, isReactive } from './reactive'
import { CollectionTypes } from './collectionHandlers'

declare const RefSymbol: unique symbol

//定义Ref类型形状(Ref类型接口)
export interface Ref<T = any> {
  value: T //响应式包装对象的value属性，是解包装的值
  /**
   * Type differentiator only.
   * We need this to be in public d.ts but don't want it to show up in IDE
   * autocomplete, so we use a private Symbol instead.
   */
  [RefSymbol]: true //用一个symbol来标识ref对象，但是后面又被改成了通过_isRef属性来标识
  /**
   * @internal
   */

  _shallow?: boolean //标识是否是浅模式
}

export type ToRefs<T = any> = { [K in keyof T]: Ref<T[K]> }

//object 类型 深层追踪转换 raw - > proxy
const convert = <T extends unknown>(val: T): T =>
  isObject(val) ? reactive(val) : val

export function isRef<T>(r: Ref<T> | unknown): r is Ref<T>
//判断是否是Ref类型,通过__v_isRef属性(创建Ref包装对象的时候会添加__v_isRef:true标识)
export function isRef(r: any): r is Ref {
  return Boolean(r && r.__v_isRef === true)
}

//函数重载
export function ref<T extends object>(
  value: T
): T extends Ref ? T : Ref<UnwrapRef<T>>
export function ref<T>(value: T): Ref<UnwrapRef<T>>
export function ref<T = any>(): Ref<T | undefined>
//ref方法
export function ref(value?: unknown) {
  //创建Ref实例对象(包装对象)
  return createRef(value)
}

//浅模式(shallow:true)创建Ref包装对象
export function shallowRef<T extends object>(
  value: T
): T extends Ref ? T : Ref<T>
export function shallowRef<T>(value: T): Ref<T>
export function shallowRef<T = any>(): Ref<T | undefined>
//创建一个 ref ，将会追踪它的 .value 更改操作，但是并不会对变更后的 .value 做响应式代理转换（即变更不会调用 reactive）
export function shallowRef(value?: unknown) {
  return createRef(value, true)
}

//创建Ref实例对象的工厂类
class RefImpl<T> {
  //私有属性,.value 的返回值
  private _value: T
  //只读属性,标识是否已经是Ref类型
  public readonly __v_isRef = true
  //构造函数,初始化Ref实例时执行,_rawValue保存原始值,_shallow标识是否深度追踪_rawValue
  constructor(private _rawValue: T, public readonly _shallow = false) {
    //如果_shallow为false则不去深层追踪,如果是true则调用convert方法去对obj类型深层次追踪转换(rawValue - >proxy)
    this._value = _shallow ? _rawValue : convert(_rawValue)
  }
  //get value
  get value() {
    //track调用,用来触发依赖收集(收集.value 变更时的effect依赖)
    track(toRaw(this), TrackOpTypes.GET, 'value')
    return this._value
  }

  //set value
  set value(newVal) {
    if (hasChanged(toRaw(newVal), this._rawValue)) {
      this._rawValue = newVal
      this._value = this._shallow ? newVal : convert(newVal)
      //trigger通知deps 触发依赖去更新(遍历执行所有对.value操作依赖的effect)
      trigger(toRaw(this), TriggerOpTypes.SET, 'value', newVal)
    }
  }
}
//创建Ref实例对象
function createRef(rawValue: unknown, shallow = false) {
  //如果已经是Ref类型,就直接返回,不再去重新创建Ref实例
  if (isRef(rawValue)) {
    return rawValue
  }
  //创建Ref实例
  return new RefImpl(rawValue, shallow)
}
//触发依赖更新
export function triggerRef(ref: Ref) {
  trigger(toRaw(ref), TriggerOpTypes.SET, 'value', __DEV__ ? ref.value : void 0)
}
//解套Ref(如果参数是一个 ref 则返回它的 value，否则返回参数本身)
export function unref<T>(ref: T): T extends Ref<infer V> ? V : T {
  return isRef(ref) ? (ref.value as any) : ref
}


const shallowUnwrapHandlers: ProxyHandler<any> = {
  get: (target, key, receiver) => unref(Reflect.get(target, key, receiver)),
  set: (target, key, value, receiver) => {
    const oldValue = target[key]
    if (isRef(oldValue) && !isRef(value)) {
      oldValue.value = value
      return true
    } else {
      return Reflect.set(target, key, value, receiver)
    }
  }
}

export function proxyRefs<T extends object>(
  objectWithRefs: T
): ShallowUnwrapRef<T> {
  return isReactive(objectWithRefs)
    ? objectWithRefs
    : new Proxy(objectWithRefs, shallowUnwrapHandlers)
}

//定义自定义Ref 工厂函数形状
export type CustomRefFactory<T> = (
  track: () => void,
  trigger: () => void
) => {
  get: () => T
  set: (value: T) => void
}

//创建自定义Ref实例对象的工厂类
class CustomRefImpl<T> {
  private readonly _get: ReturnType<CustomRefFactory<T>>['get']
  private readonly _set: ReturnType<CustomRefFactory<T>>['set']

  public readonly __v_isRef = true

  constructor(factory: CustomRefFactory<T>) {
    const { get, set } = factory(
      () => track(this, TrackOpTypes.GET, 'value'),
      () => trigger(this, TriggerOpTypes.SET, 'value')
    )
    this._get = get
    this._set = set
  }

  get value() {
    return this._get()
  }

  set value(newVal) {
    this._set(newVal)
  }
}
//自定义Ref
//可以显式地控制依赖追踪和触发响应，接受一个工厂函数，
//两个参数分别是用于追踪的 track 与用于触发响应的 trigger，并返回一个带有 get 和 set 属性的对象。
export function customRef<T>(factory: CustomRefFactory<T>): Ref<T> {
  return new CustomRefImpl(factory) as any
}

//把一个响应式对象转换成普通对象，该普通对象的每个 property 都是一个 ref ，和响应式对象 property 一一对应。
export function toRefs<T extends object>(object: T): ToRefs<T> {
  //__DEV__:全局变量,默认为true,object必须是一个proxy代理(开发模式下,传入目标如果不是对象类型,会报警告!)
  if (__DEV__ && !isProxy(object)) {
    console.warn(`toRefs() expects a reactive object but received a plain one.`)
  }
  //创建ret(Object/Array)
  const ret: any = isArray(object) ? new Array(object.length) : {}
  //将proxy代理中的key一一存入ret,并且都是一个Ref类型
  for (const key in object) {
    ret[key] = toRef(object, key)
  }
  //返回ret(ret是一个属性/元素均为Ref类型的对象/数组)
  //从一个组合逻辑函数中返回响应式对象时，用 toRefs 是很有效的，
  //该 API 让消费组件可以 解构 / 扩展（使用 ... 操作符）返回的对象，并不会丢失响应性
  return ret
}

class ObjectRefImpl<T extends object, K extends keyof T> {
  public readonly __v_isRef = true

  constructor(private readonly _object: T, private readonly _key: K) {}

  get value() {
    return this._object[this._key]
  }

  set value(newVal) {
    this._object[this._key] = newVal
  }
}

//为一个 reactive 对象的属性创建一个 ref。这个 ref 可以被传递并且能够保持响应性。
export function toRef<T extends object, K extends keyof T>(
  object: T,
  key: K
): Ref<T[K]> {
  //如果已经是Ref类型则直接返回,如果不是,则为对象属性创建Ref包装类型,
  return isRef(object[key])
    ? object[key]
    : (new ObjectRefImpl(object, key) as any)
}

// corner case when use narrows type
// Ex. type RelativePath = string & { __brand: unknown }
// RelativePath extends object -> true
type BaseTypes = string | number | boolean

/**
 * This is a special exported interface for other packages to declare
 * additional types that should bail out for ref unwrapping. For example
 * \@vue/runtime-dom can declare it like so in its d.ts:
 *
 * ``` ts
 * declare module '@vue/reactivity' {
 *   export interface RefUnwrapBailTypes {
 *     runtimeDOMBailTypes: Node | Window
 *   }
 * }
 * ```
 *
 * Note that api-extractor somehow refuses to include `declare module`
 * augmentations in its generated d.ts, so we have to manually append them
 * to the final generated d.ts in our build process.
 */
export interface RefUnwrapBailTypes {}

export type ShallowUnwrapRef<T> = {
  [K in keyof T]: T[K] extends Ref<infer V> ? V : T[K]
}

export type UnwrapRef<T> = T extends Ref<infer V>
  ? UnwrapRefSimple<V>
  : UnwrapRefSimple<T>

type UnwrapRefSimple<T> = T extends
  | Function
  | CollectionTypes
  | BaseTypes
  | Ref
  | RefUnwrapBailTypes[keyof RefUnwrapBailTypes]
  ? T
  : T extends Array<any>
    ? { [K in keyof T]: UnwrapRefSimple<T[K]> }
    : T extends object ? UnwrappedObject<T> : T

// Extract all known symbols from an object
// when unwrapping Object the symbols are not `in keyof`, this should cover all the
// known symbols
type SymbolExtract<T> = (T extends { [Symbol.asyncIterator]: infer V }
  ? { [Symbol.asyncIterator]: V }
  : {}) &
  (T extends { [Symbol.hasInstance]: infer V }
    ? { [Symbol.hasInstance]: V }
    : {}) &
  (T extends { [Symbol.isConcatSpreadable]: infer V }
    ? { [Symbol.isConcatSpreadable]: V }
    : {}) &
  (T extends { [Symbol.iterator]: infer V } ? { [Symbol.iterator]: V } : {}) &
  (T extends { [Symbol.match]: infer V } ? { [Symbol.match]: V } : {}) &
  (T extends { [Symbol.matchAll]: infer V } ? { [Symbol.matchAll]: V } : {}) &
  (T extends { [Symbol.replace]: infer V } ? { [Symbol.replace]: V } : {}) &
  (T extends { [Symbol.search]: infer V } ? { [Symbol.search]: V } : {}) &
  (T extends { [Symbol.species]: infer V } ? { [Symbol.species]: V } : {}) &
  (T extends { [Symbol.split]: infer V } ? { [Symbol.split]: V } : {}) &
  (T extends { [Symbol.toPrimitive]: infer V }
    ? { [Symbol.toPrimitive]: V }
    : {}) &
  (T extends { [Symbol.toStringTag]: infer V }
    ? { [Symbol.toStringTag]: V }
    : {}) &
  (T extends { [Symbol.unscopables]: infer V }
    ? { [Symbol.unscopables]: V }
    : {})

type UnwrappedObject<T> = { [P in keyof T]: UnwrapRef<T[P]> } & SymbolExtract<T>
