import { track, trigger } from './effect'
import { TrackOpTypes, TriggerOpTypes } from './operations'
import { isArray, isObject, hasChanged } from '@vue/shared'
import { reactive, isProxy, toRaw, isReactive } from './reactive'
import { CollectionTypes } from './collectionHandlers'

declare const RefSymbol: unique symbol

//定义Ref类型接口
export interface Ref<T = any> {
  value: T //响应式包装对象的value属性,类型为 any,因此 传入 ref 方法的参数 既可以是原始值类型也可以是对象类型
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

//判断是否是一个 Ref 类型
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

//创建Ref包装对象的工厂类
class RefImpl<T> {
  //私有属性,保存传入的原始值,也是.value 的返回值
  private _value: T
  //只读属性,标记当前对象是 Ref 类型
  public readonly __v_isRef = true
  //构造函数,初始化ref实例时执行,_rawValue接收传入的原始值,_shallow只读属性,标记是否去深层追踪传入的原始值
  constructor(private _rawValue: T, public readonly _shallow = false) {
    //如果_shallow为false则不去深层追踪,如果是true则调用convert方法去对原始值进行深层次追踪转换
    this._value = _shallow ? _rawValue : convert(_rawValue)
  }
  //get value
  get value() {
    //用来执行依赖收集(收集.value 变更时的effect依赖)
    track(toRaw(this), TrackOpTypes.GET, 'value')
    return this._value
  }

  //set value
  set value(newVal) {
    //只有传入值发生变化,才可以触发依赖更新
    if (hasChanged(toRaw(newVal), this._rawValue)) {
      this._rawValue = newVal
      this._value = this._shallow ? newVal : convert(newVal)
      //trigger通知deps 触发所有对该值有依赖的effct函数去执行调用更新
      trigger(toRaw(this), TriggerOpTypes.SET, 'value', newVal)
    }
  }
}
//createRef方法
function createRef(rawValue: unknown, shallow = false) {
  //如果已经是Ref类型,就直接返回,不再去重新创建Ref实例
  if (isRef(rawValue)) {
    return rawValue
  }
  //创建Ref实例
  return new RefImpl(rawValue, shallow)
}
//triggerRef
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

//将一个属性为Ref类型的普通对象转换成proxy对象，获取属性时候可以解套返回
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

//创建自定义Ref包装对象的工厂类
class CustomRefImpl<T> {
  private readonly _get: ReturnType<CustomRefFactory<T>>['get']
  private readonly _set: ReturnType<CustomRefFactory<T>>['set']

  public readonly __v_isRef = true

  constructor(factory: CustomRefFactory<T>) {
    //工厂函数会返回一个包含 get和set 方法的对象，get,set 方法里面实现自定义逻辑
    const { get, set } = factory(
      () => track(this, TrackOpTypes.GET, 'value'),
      () => trigger(this, TriggerOpTypes.SET, 'value')
    )
    this._get = get
    this._set = set
  }
  //访问 .value 返回 get 方法执行的结果
  get value() {
    return this._get()
  }
  // 修改 .value 去执行 set 方法
  set value(newVal) {
    this._set(newVal)
  }
}
//自定义Ref
//可以显式地控制依赖追踪和触发响应，接受一个工厂函数，
//两个参数分别是收集依赖的 track 与用于触发依赖更新的 trigger，并返回一个带有 get 和 set 属性的对象。
export function customRef<T>(factory: CustomRefFactory<T>): Ref<T> {
  return new CustomRefImpl(factory) as any
}

//把一个响应式对象转换成普通对象，该普通对象的每个 property 都是一个 ref ，和响应式对象 property 一一对应。
export function toRefs<T extends object>(object: T): ToRefs<T> {
  //__DEV__:全局变量,默认为true,object必须是一个响应式代理对象(开发模式下,传入目标对象如果不是一个响应式代理对象,会报警告!)
  if (__DEV__ && !isProxy(object)) {
    console.warn(`toRefs() expects a reactive object but received a plain one.`)
  }
  //创建传入对象的普通映射对象(数组)
  const ret: any = isArray(object) ? new Array(object.length) : {}
  //遍历传入的响应式式对象，使用 toRef 方法为其每一个元素（属性）生成一个ref包装类型对象，然后存入映射对象(数组)中
  for (const key in object) {
    ret[key] = toRef(object, key)
  }

  return ret
}

//为 reactive 对象的属性创建一个ref包装类型对象（将对象属性包装成Ref类型，从而使其具有响应性）
class ObjectRefImpl<T extends object, K extends keyof T> {
  public readonly __v_isRef = true //Ref类型标识

  constructor(private readonly _object: T, private readonly _key: K) {}

  //get value
  get value() {
    return this._object[this._key]
  }
  //set value
  set value(newVal) {
    this._object[this._key] = newVal
  }
}

//用来为一个 reactive 对象的属性创建一个 ref。这个 ref 可以被传递并且能够保持响应性。
export function toRef<T extends object, K extends keyof T>(
  object: T,
  key: K
): Ref<T[K]> {
  //如果已经是Ref类型则直接返回,如果不是,则为对象属性创建一个Ref包装对象,
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
