import { TrackOpTypes, TriggerOpTypes } from './operations'
import { EMPTY_OBJ, isArray, isIntegerKey, isMap } from '@vue/shared'

// The main WeakMap that stores {target -> key -> dep} connections.
// Conceptually, it's easier to think of a dependency as a Dep class
// which maintains a Set of subscribers, but we simply store them as
// raw Sets to reduce memory overhead.
type Dep = Set<ReactiveEffect>
type KeyToDepMap = Map<any, Dep>
const targetMap = new WeakMap<any, KeyToDepMap>()

//定义effect类型
export interface ReactiveEffect<T = any> {
  (): T //ReactiveEffect函数
  _isEffect: true //用来标识是effect类型
  id: number //id号
  active: boolean //active是激活effect的开关，打开会收集依赖，关闭会导致收集依赖无效
  raw: () => T // 侦听函数的原始函数
  deps: Array<Dep> // 存储依赖(effect)的deps
  options: ReactiveEffectOptions // 相关选项
  allowRecurse: boolean //是否允许递归
}

//定义effectOptions类型
export interface ReactiveEffectOptions {
  lazy?: boolean // 延迟计算的标识(默认false,开启的话,effect函数不会立刻执行一次,会延迟到依赖关系被触发时才执行)
  scheduler?: (job: ReactiveEffect) => void // 自定义的依赖收集函数，一般用于外部引入@vue/reactivity时使用
  onTrack?: (event: DebuggerEvent) => void // 本地调试钩子(仅在开发模式下生效)
  onTrigger?: (event: DebuggerEvent) => void // 本地调试钩子(仅在开发模式下生效)
  onStop?: () => void //本地调试时钩子(仅在开发模式下生效)
  allowRecurse?: boolean //是否允许递归
}

//debugger 事件
export type DebuggerEvent = {
  effect: ReactiveEffect
  target: object
  type: TrackOpTypes | TriggerOpTypes
  key: any
} & DebuggerEventExtraInfo

// debugger扩展信息
export interface DebuggerEventExtraInfo {
  newValue?: any
  oldValue?: any
  oldTarget?: Map<any, any> | Set<any>
}

//effectStack用于存放所有effect的数组
const effectStack: ReactiveEffect[] = []
//当前被激活的effect
let activeEffect: ReactiveEffect | undefined

export const ITERATE_KEY = Symbol(__DEV__ ? 'iterate' : '')
export const MAP_KEY_ITERATE_KEY = Symbol(__DEV__ ? 'Map key iterate' : '')

//判断传入的fn是否已经是一个侦听函数了,判断标识为_isEffect属性,如果不是,则没有该属性标识
export function isEffect(fn: any): fn is ReactiveEffect {
  return fn && fn._isEffect === true
}

//创建侦听函数的工厂函数effect
export function effect<T = any>(
  fn: () => T, //包装了源数据的原始函数
  options: ReactiveEffectOptions = EMPTY_OBJ //配置项，可以是 { immediate, deep, flush, onTrack, onTrigger }
): ReactiveEffect<T> {
  //如果传入的 fn 源数据函数已经是一个侦听函数了(创建过了)那此时它内部会挂载有一个raw属性,用来缓存原函数体,
  //当再次被传入时会自动获取到其内部的源函数,然后会使用源函数创建一个新的侦听函数，所以effect始终会返回一个新创建的侦听函数。
  if (isEffect(fn)) {
    fn = fn.raw
  }
  //执行创建的函数
  const effect = createReactiveEffect(fn, options)
  //lazy 是 options 选项的一个配置属性，如果 为true 则会懒执行副作用，反之会在侦听函数创建完后立即执行一次副作用
  //vue组件实例中，lazy属性默认是true（在vue.global.js中会看到），但是在vue组建中 lazy 默认为true并不和effect创建后默认会立即执行一次
  //的逻辑相冲突，因为在  vue.global.js 中我们看到了，有关很多条件的判断，所以，如果是 watchEffect则会在effect创建完以后去主动调用一次
  //runner 也就是这里的 effect。
  if (!options.lazy) {
    effect()
  }
  //返回侦听函数
  return effect
}

//停止侦听的函数(该函数会在watch/watchEffect返回的函数中调用,例如官方文档所说的stop(),内部就是调用的是该函数来停止依赖侦听)
export function stop(effect: ReactiveEffect) {
  // 如果当前effect是active的,则清除其内部所有依赖(清空deps)
  if (effect.active) {
    // 清除effect的所有依赖
    cleanup(effect)
    // 如果有onStop钩子，调用该钩子函数(会最为选项参数传入)
    if (effect.options.onStop) {
      effect.options.onStop()
    }
    // active标记为false，标识这个effect已经停止收集依赖了(停止依赖侦听)
    effect.active = false
  }
}

let uid = 0 //id 标识，应该是用来标识唯一性的，不用去细究

//执行创建侦听函数
function createReactiveEffect<T = any>(
  fn: () => T, //源数据函数
  options: ReactiveEffectOptions //配置项 可以是 { immediate, deep, flush, onTrack, onTrigger }
): ReactiveEffect<T> {
  //初始化一个侦听函数，函数本质也是对象，所以可以挂载/扩展一些有用的属性
  const effect = function reactiveEffect(): unknown {
    //active 是 effect 侦听函数上扩展的一个属性，默认 active 为true,表示一个有效的侦听函数，当侦听属性的值发生变化时就会去
    //执行副作用，active 为false 的唯一时机是 stop方法触发，就是上面这个stop函数，此时，侦听函数就会失去侦听的能力，即响应性失效
    if (!effect.active) {
      //scheduler 是自定义调度器，用来调度触发侦听函数，会看到如果侦听函数失效后，如果自定了调度器，那么会直接返回undefined来终止
      //程序继续进行，如果没有自定义调度器，则执行源数据函数，这时候因为依赖都被移除掉了，因此是不会触发依赖收集操作，相当于执行了一次普通的
      //函数调用而已
      return options.scheduler ? undefined : fn()
    }
    //这里进行一次effectStack 中是否有 effect 判断的目的是为了防止同一个侦听函数被连续触发多次引起死递归。
    //假如此时正在执行副作用函数，该函数内部有修改依赖属性的操作，修改会触发 trigger， 进而会再次触发侦听函数执行，
    //然后副作用函数执行，这样当前的副作用函数就会无限递归下去，因此为了避免此现象发生，就会在副作用函数执行之前进行先一次判断。
    //如果当前侦听函数还没有出栈，就啥也不执行。
    if (!effectStack.includes(effect)) {
      //cleanup 函数的作用有两个，1：会移除掉依赖映射表(targetMap)里面的effect侦听器函数（也叫依赖函数），2：清空effect侦听函数中的deps
      //会发现 cleanup 操作是在每次即将执行副作用函数之前执行的，也就是在每次依赖重新收集之前会清空之前的依赖。这样做的目的是为了保证
      //依赖属性时刻对应最新的侦听函数。
      cleanup(effect)
      try {
        //当前effect侦听函数 入栈,并激活设置为 activeEffect
        enableTracking()
        effectStack.push(effect)
        activeEffect = effect
        //fn为副作用函数,若该函数里的响应式对象有属性的访问操作,则会触发getter,getter里会调用track()方法,进而实现依赖的重新收集
        return fn()
      } finally {
        //副作用函数执行完后,当前effect副作用函数出栈,并撤销激活态
        effectStack.pop()
        resetTracking()
        activeEffect = effectStack[effectStack.length - 1]
      }
    }
  } as ReactiveEffect
  //函数也是对象类型,因此可以给effect侦听扩展一些有用的属性
  effect.id = uid++ //id 唯一标识
  effect.allowRecurse = !!options.allowRecurse //是否允许递归（这个属性本意是用来控制侦听函数是否可以递归执行，但是实际发现并无卵用即使为true）
  effect._isEffect = true //是侦听函数标识，如果有此属性表明已经是一个侦听函数了
  effect.active = true //控制侦听函数的响应性，为false将失去响应性
  effect.raw = fn //缓存 fn 源数据函数
  effect.deps = [] //存储依赖dep。
  effect.options = options //可配置选项
  return effect //将创建好的侦听函数返回
}

// 清除依赖，该方法会在侦听函数每次将要执行副作用函数前或触发stop()函数时调用，用来清除依赖的
function cleanup(effect: ReactiveEffect) {
  const { deps } = effect
  if (deps.length) {
    for (let i = 0; i < deps.length; i++) {
      deps[i].delete(effect)
    }
    deps.length = 0
  }
}
//全局开关变量，默认打开track，如果关闭track，则会导致 Vue 内部停止对变化进行追踪
let shouldTrack = true
const trackStack: boolean[] = []

export function pauseTracking() {
  trackStack.push(shouldTrack)
  shouldTrack = false
}

export function enableTracking() {
  trackStack.push(shouldTrack)
  shouldTrack = true
}

export function resetTracking() {
  const last = trackStack.pop()
  shouldTrack = last === undefined ? true : last
}
//依赖收集函数，当响应式数据属性被访问时该函数会被触发,从而收集有关访问属性的侦听函数（也叫依赖函数）effect
//target:原始目标对象（代理对象所对应的原始对象），type: 操作类型，key：访问属性名
export function track(target: object, type: TrackOpTypes, key: unknown) {
  // 如果shouldTrack状态为false，或当前无激活态侦听函数触发，则不去收集依赖（说明没有可收集的依赖）
  if (!shouldTrack || activeEffect === undefined) {
    return
  }
  //targetMap 是一个WeakMap集合，也叫依赖映射表(容器)，以原始目标对象为 key，depsMap(是一个Map集合)为value进行存储
  //depsMap中又以访问属性为 key，dep(是一个Set集合，自带去重功能)为value进行存储。dep集合中会存放 effect 侦听函数，
  //这些侦听函数也可以被称为访问属性的依赖函数，当访问属性值发生变化时依赖函数就会被触发。

  //获取依赖map
  let depsMap = targetMap.get(target)
  //如果依赖map不存在,则去初始化一个
  if (!depsMap) {
    targetMap.set(target, (depsMap = new Map()))
  }
  //依赖map中获取访问属性对应的依赖集合
  let dep = depsMap.get(key)
  //如果不存在依赖集合，则去初始化一个
  if (!dep) {
    depsMap.set(key, (dep = new Set()))
  }
  //检测dep依赖集合中是否有当前激活态的侦听函数，如果没有则把它存进去（这个过程就叫依赖收集）
  if (!dep.has(activeEffect)) {
    dep.add(activeEffect)
    //activeEffect 其实是当前正在执行的激活态的 effect侦听函数，这一步将存储访问属性有关的所有依赖函数的dep集合push进
    //当前侦听函数的deps（数组）中，建立了一个双向映射关系，这个双向映射关系会在每次副作用函数即将执行前的 cleanup操作时发挥作用
    //会将先前收集进depsMap 里所有访问属性的dep集合中该侦听函数（依赖函数）移除掉。然后在执行副作用函数的时候再次执行进track函数时重新
    //收集回来，这样的操作看似有点蛋疼，但经过细品后确实不是蛋疼所为，而是为了保证依赖的最新性。
    activeEffect.deps.push(dep)

    //只有开发环境下，才去触发相应的钩子函数(调试钩子)
    if (__DEV__ && activeEffect.options.onTrack) {
      activeEffect.options.onTrack({
        effect: activeEffect,
        target,
        type,
        key
      })
    }
  }
}

//触发依赖更新函数
export function trigger(
  target: object, //原始目标对象（代理对象所对应的原始对象）
  type: TriggerOpTypes, //操作类型
  key?: unknown, //要修改/设置的属性名
  newValue?: unknown, //新属性值
  oldValue?: unknown, //旧属性值
  oldTarget?: Map<unknown, unknown> | Set<unknown> //貌似只会在开发模式的调试下用到，不用去管
) {
  //获取目标对象在依赖映射表中对应的映射集合depsMap
  const depsMap = targetMap.get(target)
  //如果depsMap不存在,说明未收集过有关该原始对象的属性依赖,直接返回,不用去触发依赖更新
  if (!depsMap) {
    // never been tracked
    return
  }

  //初始化一个effects集合 (set集合)用来存放要被执行的侦听函数（依赖函数）
  const effects = new Set<ReactiveEffect>()
  //add effect into effects
  //add 是将 effect 侦听函数 添加进 effects 集合的添加方法
  const add = (effectsToAdd: Set<ReactiveEffect> | undefined) => {
    //effectsToAdd 其实就是从depsMap中执行属性对应的dep集合，里面存放的是一个个effect侦听函数
    if (effectsToAdd) {
      //执行遍历添加
      effectsToAdd.forEach(effect => {
        //添加条件： 要添加的侦听函数需要是一个非激活态，或者 allowRecurse 配置属性为true,才可以添加
        //但是单测实例时发现 allowRecurse 属性无论是 true or false 侦听函数effect都不会发生递归，因此
        //我感觉这个属性是多余的。
        if (effect !== activeEffect || effect.allowRecurse) {
          effects.add(effect)
        }
      })
    }
  }
  //如果操作类型为 clear,则将传入属性相关的所有依赖函数都触发，因为清空操作会清空整个集合，所以每一个集合属性的依赖都有影响
  if (type === TriggerOpTypes.CLEAR) {
    // collection being cleared
    // trigger all effects for target
    depsMap.forEach(add)
    //如果是修改数组长度操作,则将depsMap中有关 length 对应的依赖项以及数组中索引不大于新数组长度的下标对应的依赖添加 进effects中
    //因为数组长度变了，数组原来所有不大于新长度的索引对应的元素都会被重新设置一次，因此会触发依赖更新
  } else if (key === 'length' && isArray(target)) {
    depsMap.forEach((dep, key) => {
      if (key === 'length' || key >= (newValue as number)) {
        add(dep)
      }
    })
  } else {
    // schedule runs for SET | ADD | DELETE
    //如果能进else说明肯定是SET | ADD | DELETE 中的某一种操作，若key不为 undefined，说明key是一个有效的属性，则获取该属性对应的所有依赖函数
    //添加进 effects 集合
    if (key !== void 0) {
      //void 0 = undefined
      add(depsMap.get(key))
    }

    // also run for iteration key on ADD | DELETE | Map.SET
    //这里先回顾下什么情况下会收集  ITERATE_KEY 和 MAP_KEY_ITERATE_KEY 为 key 的依赖，
    //1. baseHandlers.ts -> ownKeys 捕获方法中，这个方法被触发的时机是监听到Object.keys()被调用。
    //2. collectionHandlers.ts -> 插装方法 size，迭代方法 ['keys', 'values', 'entries',forEach, Symbol.iterator]中。获取集合长度.size 时触发 size方法，调用 Map,Set集合的迭代方法（keys,values,entries,forEach,for...of 等）。
    //ADD 表示新增属性操作，DELETE 表示删除属性操作 ，SET 表示修改属性操作。不同的操作类型下会根据目标对象的类型不同去触发更新对应的迭代依赖
    //这些迭代依赖之所以要去更新，是因为当前的操作会对收集的依赖有影响，如果不去更新，那就不能保证依赖数据的最新。
    switch (type) {
      //新增属性操作
      case TriggerOpTypes.ADD:
        if (!isArray(target)) {
          add(depsMap.get(ITERATE_KEY))
          if (isMap(target)) {
            add(depsMap.get(MAP_KEY_ITERATE_KEY))
          }
        } else if (isIntegerKey(key)) {
          // new index added to array -> length changes
          add(depsMap.get('length'))
        }
        break
      //删除属性操作
      case TriggerOpTypes.DELETE:
        if (!isArray(target)) {
          add(depsMap.get(ITERATE_KEY))
          if (isMap(target)) {
            add(depsMap.get(MAP_KEY_ITERATE_KEY))
          }
        }
        break
      //修改属性操作
      case TriggerOpTypes.SET:
        if (isMap(target)) {
          add(depsMap.get(ITERATE_KEY))
        }
        break
    }
  }

  //更新依赖函数的执行方法
  const run = (effect: ReactiveEffect) => {
    //开发模式下的调试钩子函数
    if (__DEV__ && effect.options.onTrigger) {
      effect.options.onTrigger({
        effect,
        target,
        key,
        type,
        newValue,
        oldValue,
        oldTarget
      })
    }
    //如果侦听函数的options配置选项上挂载了 scheduler 调度器，则使用调度器去执行侦听函数，否则直接执行侦听函数
    if (effect.options.scheduler) {
      effect.options.scheduler(effect)
    } else {
      effect()
    }
  }
  //遍历effects集合，执行侦听函数的更新。
  effects.forEach(run)
}
