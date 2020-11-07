## ref 源码分析

### 前言

- ref 中文翻译过来叫一个 `响应式的引用`。给 ref 方法传入一个原始值，会返回一个可改变的响应式对象，所以可以理解为 ref 就是一个 `响应式对象的引用`，俗称 ref 对象。

- ref 对象是一个包装对象，它有一个指向内部值的单一属性 .value。通过操作 value 属性(获取/修改)我们就可以实现原始值的响应式，所以 ref 方法的作用就是将一个原始值变成响应式。

- 虽然明白了其作用,但并不清楚内部实现过。所以，带着这样的好奇，接下来我们就深入到它的源码层面,来一探究竟其实现原理。

### 源码分析

我们进入源码的 packages/reactivity 目录下，该目录就是 vue3.0 响应式模块的源码存放处, 然后 src 下找到 ref.ts。
首先会看到文件顶部定义了一个 symbol 类型的变量 `RefSymbol`，下来又定义了一个 Ref 类型的接口(ts 中接口是用来约束对象类型形状的一种方式)，`RefSymbol` 作为 Ref 类型接口的 一个属性,用来标识 ref 对象(使用 symbol 类型作为标识名,是因为它唯一不可重复性)，但是后面又改用只读属性 `__v_isRef`，到后面会看到，`value` 指向内部值的单一属性(通过操作 value 属性(获取/修改)我们就可以实现原始值的响应式)， `_shallow` 也是一个标识属性，标记是否是浅模式(浅模式主要针对.value 指向的内部值为对象类型时候不去深度追踪它)。

```js
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
```

明确了 Ref 包装对象的类型之后，我们接下来就看看 ref 方法，知道鸡生蛋的过程，才是最重要的。

```js
//ref方法
export function ref(value?: unknown) {
  //创建Ref实例对象(包装对象)
  return createRef(value)
}

//createRef方法
function createRef(rawValue: unknown, shallow = false) {
  //如果已经是 Ref 类型,就直接返回,不再去重新创建 ref 实例
  if (isRef(rawValue)) {
    return rawValue
  }
  //创建Ref实例
  return new RefImpl(rawValue, shallow)
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
```

`ref` 方法接收一个 `value` 参数，然后内部调用 `createRef` 方法并返回 `createRef` 的返回值。 `createRef` 接收两个参数，第一个参数就是外部传入的原始值，第二个参数标记是否是浅模式创建，默认值为 `false`，首先会判断传入的原始值是否已经是 `Ref` 类型,如果已经是,就直接返回( Ref 类型不支持 Ref 嵌套,即 value 不能是一个 ref 对象),否则就去执行创建(new RefImpl). RefImpl 是一个工厂类(工厂函数)，是实际生产 ref 包装对象的地方， `_value` 私有属性保存传入的原始值,只能在当前类内部访问，`__v_isRef` 只读属性标记当前对象是 Ref 类型, `_shallow` 只读属性标记是否去深层追踪传入的原始值, `get value()` 获取 value 属性的时候调用，内部调用 `track` 执行依赖收集，然后返回 `_value`， `set value()` 修改 value 属性的时候调用,首先会更新`_value` ，然后内部调用 `trigger` 去通知各依赖更新（关于 `track` 方法和 `trigger` 我们会在 `effect`源码章节详细分析其内部原理,今天我们只知道它们各自的作用就行）。 通过 `new RefImpl(rawValue, shallow)` 执行 `constructor` 后 Ref 包装对象就被创建成功了，这个过程可以用一句话总结，就是： `给 ref 传入一个原始值，会返回一个响应式且可改变的 ref 对象`。

- 创建 ref 对象开始时首先会判断已经是否是一个 Ref 类型，这里用到了 `isRef` 这个方法。

```js
//判断是否是Ref类型,通过__v_isRef属性(创建Ref包装对象的时候会添加__v_isRef:true标识)
export function isRef(r: any): r is Ref {
  return Boolean(r && r.__v_isRef === true)
}
```

会看到判断的依据是目标对象 r 内部是否有一个值为 `true` 的 `__v_isRef` 属性，因为创建 ref 对象的过程中，会默认给添加`__v_isRef`属性，默认值为 true（RefImpl 工厂类中）

- 笔者这里所说的 `原始值` 并非 js 数据类型中的 `原始值` 类型的意思，是指传入的原始参数意思，因此这个原始参数既可以是原始数据类型，也可以是对象类型，因此，也就有了浅模式这个概念。默认情况下（\_shallow: false）会深层追踪传入的原始值，这里会用的一个方法 `convert(_rawValue)`。

```js
//object 类型 深层追踪转换 raw - > proxy
const convert = <T extends unknown>(val: T): T =>
  isObject(val) ? reactive(val) : val

  export const isObject = (val: unknown): val is Record<any, any> =>
  val !== null && typeof val === 'object'
```

convert 接收 val 参数，然后判断 val 是否是对象类型，如果不是则直接返回原始值，如果是则调用 `reactive` 方法进行响应式处理，即返回该传入的普通对象的响应式代理 `Proxy`（reactive 方法会在 reactive 章节详细介绍）。

经过以上流程，一个性感好看的 Ref 包装对象就被创建好了。

下来对一些工具方法进行分析

#### unref

```js
//解套ref(如果参数是一个 ref 对象则返回它的 value 属性值，否则返回参数本身)
export function unref<T>(ref: T): T extends Ref<infer V> ? V : T {
  return isRef(ref) ? (ref.value as any) : ref
}
```

该方法解套 ref 对象，如果传入参数是一个 ref 对象（调用 isRef 方法判断对象内部是否有一个值为 `true` 的 `__v_isRef` 属性），则返回它的 .value 属性，否则的话就返回其本身（不是 ref 对象则不需要解套）。

#### toRef

```js
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
```

toRef 接收两个参数，第一个参数是 一个 reactive 对象，第二个参数是该对象的一个属性，返回值是一个 Ref 类型的包装对象，
如果判断当前这个属性已经是一个 ref 对象则直接返回，如果不是，则去创建，这里用到了一个工厂类（ObjectRefImpl）

```js
//为 reactive 对象的属性创建一个ref包装类型对象（将对象属性包装成Ref类型，从而使其具有响应性）
class ObjectRefImpl<T extends object, K extends keyof T> {
  public readonly __v_isRef = true

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
```

会发现 `ObjectRefImpl`创建实例的过程跟 `RefImpl` 很相似，都是最终会得到一个拥有 `.value` 内部属性和 `__v_isRef = true` 标识的 Ref 包装对象，只不过这里操作的原始值是传入的 reactive 对象的特定属性。

#### toRefs

```js
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
```

toRefs 方法用来把一个响应式对象转换成普通对象，该普通对象的每个 property 都是一个 ref ，和响应式对象 property 一一对应。从一个组合逻辑函数中返回响应式对象时，用 toRefs 是很有效的，该 API 让消费组件可以 解构 / 扩展（使用 ... 操作符）返回的对象，并不会丢失响应性，因为解构出来的每一个属性/元素都是一个 ref 对象。例如官方栗子：

```js
function useFeatureX() {
  const state = reactive({
    foo: 1,
    bar: 2
  })

  // 对 state 的逻辑操作

  // 返回时将属性都转为 ref(如若不进行属性 ref 转换，比如下方 setup() 中解构使用，则会丢失其响应式，因为此时的响应式是代理对象的，单独的属性使用并不具有)
  return toRefs(state)
}

export default {
  setup() {
    // 可以解构，不会丢失响应性
    const { foo, bar } = useFeatureX()

    return {
      foo,
      bar
    }
  }
}
```

#### shallowRef

```js
//创建一个浅模式下的 ref 对象 ，只会监听 .value 更改操作，但并不会对 .value 指向的对象类型原始值进行深层监听（即不会使用reactive方法处理使其成为响应式）
export function shallowRef(value?: unknown) {
  //调用 createRef 方法去创建浅模式 ref 对象，第二个参数会传给 _shallow,来标识浅模式创建
  return createRef(value, true)
}
```

shallowRef 方法用来创建一个浅模式的 Ref 类型包装对象，与创建的默认的 Ref 包装对象唯一区别就是会显式指定 \_shallow 的值 true，然后不会调用 `convert` 方法去深层追踪 .value 对应的原始值，过程前面已经讲过，这里就不再赘述。

#### customRef

```js
//自定义 ref 工厂函数类型形状
export type CustomRefFactory<T> = (
  track: () => void,
  trigger: () => void
) => {
  get: () => T
  set: (value: T) => void
}

//自定义Ref
//可以显式地控制依赖追踪和触发响应，接受一个工厂函数，
//两个参数分别是收集依赖的 track 与用于触发依赖更新的 trigger，并返回一个带有 get 和 set 属性的对象。
export function customRef<T>(factory: CustomRefFactory<T>): Ref<T> {
  return new CustomRefImpl(factory) as any
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
```

customRef 这个方法暴露出来可以供我们自定义 ref，因为是自定义，因此我们可以将一个工厂函数作为入参回调来执行自定义的逻辑，这样当我们修改
.value 的时候可以触发我们自定义的 set 方法，获取 .value 的时候触发我们自定义的 get 方法，一系列动作透明公开，细节尽收眼底（可以显式地控制依赖追踪和触发响应）。

以上就是笔者对 ref 章节的全部分析内容了，从如何创建一个 ref 对象跟 一些有用的 api 两个方面做了阐述，对于依赖收集和触发更新，我们放到 effect 章节来进行解读。作为一枚前端菜鸟，因为技术水平有限，所以在分析过程中如有不准确/不当之处，还望路过的大佬们留下正见，共同进步！

* [ref源代码传送门](https://github.com/HUYIJUNCODING/vue-next-analysis/blob/master/packages/reactivity/src/ref.ts)
